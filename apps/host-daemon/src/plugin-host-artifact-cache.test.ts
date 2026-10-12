import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { ensureCachedPluginHostArtifact } from "./plugin-host-artifact-cache.js";
import { sha256Hex } from "./sha256-hex.js";

const execute = promisify(execFile);
const directories: string[] = [];
const logger = { debug: vi.fn(), warn: vi.fn() };

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-artifact-retention-"));
  directories.push(dataDir);
  const bytes = (version: string) =>
    Buffer.from(`process.stdout.write(${JSON.stringify(version)});\n`);
  return { dataDir, bytes };
}

it("can restart a pinned older bridge after a new generation is downloaded and reused", async () => {
  const { dataDir, bytes } = await fixture();
  const oldBytes = bytes("old bridge");
  const newBytes = bytes("new bridge");
  const cache = (body: Buffer, fetchArtifact = vi.fn(async () => body)) =>
    ensureCachedPluginHostArtifact({
      dataDir,
      pluginId: "provider-test",
      digest: sha256Hex(body),
      byteLength: body.byteLength,
      fetchArtifact,
      logger,
    });

  const pinnedPath = await cache(oldBytes);
  expect((await execute(process.execPath, [pinnedPath])).stdout).toBe(
    "old bridge",
  );
  const latestPath = await cache(newBytes);
  const unavailableServer = vi.fn(async (): Promise<Buffer> => {
    throw new Error("server only serves the current generation");
  });
  expect(await cache(newBytes, unavailableServer)).toBe(latestPath);
  expect((await execute(process.execPath, [pinnedPath])).stdout).toBe(
    "old bridge",
  );
  expect(await cache(oldBytes, unavailableServer)).toBe(pinnedPath);
  expect(unavailableServer).not.toHaveBeenCalled();
  expect((await execute(process.execPath, [latestPath])).stdout).toBe(
    "new bridge",
  );
});

it("does not remove another generation while its download is in flight", async () => {
  const { dataDir, bytes } = await fixture();
  const oldBytes = bytes("older download");
  const newBytes = bytes("newer download");
  let entered!: () => void;
  let release!: () => void;
  const downloading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finishDownload = new Promise<void>((resolve) => {
    release = resolve;
  });
  const older = ensureCachedPluginHostArtifact({
    dataDir,
    pluginId: "provider-test",
    digest: sha256Hex(oldBytes),
    byteLength: oldBytes.byteLength,
    fetchArtifact: async () => {
      entered();
      await finishDownload;
      return oldBytes;
    },
    logger,
  });
  await downloading;
  try {
    const newerPath = await ensureCachedPluginHostArtifact({
      dataDir,
      pluginId: "provider-test",
      digest: sha256Hex(newBytes),
      byteLength: newBytes.byteLength,
      fetchArtifact: async () => newBytes,
      logger,
    });
    release();
    const olderPath = await older;
    expect((await execute(process.execPath, [olderPath])).stdout).toBe(
      "older download",
    );
    expect((await execute(process.execPath, [newerPath])).stdout).toBe(
      "newer download",
    );
  } finally {
    release();
    await older.catch(() => undefined);
  }
});
