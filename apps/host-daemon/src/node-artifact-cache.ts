import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOST_ARTIFACT_MAX_BYTES } from "@bb/host-daemon-contract";
import type { HostDaemonLogger } from "./logger.js";
import { sha256Hex } from "./sha256-hex.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

type FetchNodeArtifact = (args: {
  digest: string;
  byteLength: number;
}) => Promise<Uint8Array>;

interface EnsureCachedNodeArtifactArgs {
  cacheDir: string;
  digest: string;
  byteLength: number;
  fileName: string;
  fetchArtifact: FetchNodeArtifact;
  logger: Pick<HostDaemonLogger, "debug" | "warn">;
}

const pendingPulls = new Map<string, Promise<string>>();

function describeMismatch(
  digest: string,
  byteLength: number,
  bytes: Uint8Array,
): string | null {
  if (bytes.byteLength !== byteLength) {
    return `expected ${byteLength} bytes, received ${bytes.byteLength}`;
  }
  const actual = sha256Hex(bytes);
  if (actual !== digest) {
    return `expected sha256 ${digest}, received ${actual}`;
  }
  return null;
}

export async function ensureCachedNodeArtifact(
  args: EnsureCachedNodeArtifactArgs,
): Promise<string> {
  if (!DIGEST_PATTERN.test(args.digest)) {
    throw new Error(`Invalid artifact digest: "${args.digest}"`);
  }
  if (args.byteLength > HOST_ARTIFACT_MAX_BYTES) {
    throw new Error(
      `Artifact is too large: ${args.byteLength} bytes exceeds the ${HOST_ARTIFACT_MAX_BYTES}-byte limit`,
    );
  }
  const key = `${args.cacheDir}\0${args.digest}`;
  const pending = pendingPulls.get(key);
  if (pending !== undefined) {
    return pending;
  }
  const pull = ensureCachedNodeArtifactUnlocked(args).finally(() => {
    pendingPulls.delete(key);
  });
  pendingPulls.set(key, pull);
  return pull;
}

async function ensureCachedNodeArtifactUnlocked(
  args: EnsureCachedNodeArtifactArgs,
): Promise<string> {
  const directory = join(args.cacheDir, args.digest);
  const artifactPath = join(directory, args.fileName);
  if (await isVerifiedCachedArtifact(artifactPath, args)) {
    args.logger.debug(
      { cacheDir: args.cacheDir, digest: args.digest },
      "Using cached host artifact",
    );
    return artifactPath;
  }

  args.logger.debug(
    { cacheDir: args.cacheDir, digest: args.digest },
    "Downloading host artifact",
  );
  await mkdir(directory, { recursive: true });
  let lastMismatch = "unknown mismatch";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const bytes = await args.fetchArtifact({
      digest: args.digest,
      byteLength: args.byteLength,
    });
    const mismatch = describeMismatch(args.digest, args.byteLength, bytes);
    if (mismatch !== null) {
      lastMismatch = mismatch;
      continue;
    }
    const staged = join(directory, `.staged-${randomUUID()}.tmp`);
    try {
      await writeFile(staged, bytes, { mode: 0o600 });
      await rename(staged, artifactPath);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
    return artifactPath;
  }
  throw new Error(
    `Host artifact download failed verification after retry: ${lastMismatch}`,
  );
}

async function isVerifiedCachedArtifact(
  artifactPath: string,
  args: EnsureCachedNodeArtifactArgs,
): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await readFile(artifactPath);
  } catch {
    return false;
  }
  if (
    bytes.byteLength === args.byteLength &&
    sha256Hex(bytes) === args.digest
  ) {
    return true;
  }
  await rm(artifactPath, { force: true });
  return false;
}
