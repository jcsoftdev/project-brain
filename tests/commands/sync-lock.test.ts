import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSyncLock,
  syncLockPath,
  SYNC_LOCK_STALE_MS,
} from "../../src/commands/sync-lock.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-sync-lock-"));
  mkdirSync(join(root, ".project-brain"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("acquireSyncLock", () => {
  it("grants the lock and writes the holder's pid", async () => {
    const lock = await acquireSyncLock(root, { pid: 4242 });

    expect(lock).not.toBeNull();
    expect(existsSync(syncLockPath(root))).toBe(true);
    expect(JSON.parse(readFileSync(syncLockPath(root), "utf-8")).pid).toBe(4242);
  });

  it("creates .project-brain when it does not exist yet", async () => {
    const bare = mkdtempSync(join(tmpdir(), "brain-sync-lock-bare-"));
    try {
      const lock = await acquireSyncLock(bare, { pid: 1 });
      expect(lock).not.toBeNull();
      expect(existsSync(syncLockPath(bare))).toBe(true);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("refuses a second lock while a live process holds it", async () => {
    const first = await acquireSyncLock(root, { pid: 100, isAlive: () => true });
    expect(first).not.toBeNull();

    const second = await acquireSyncLock(root, { pid: 200, isAlive: () => true });
    expect(second).toBeNull();
  });

  it("takes over a lock whose holder is gone", async () => {
    await acquireSyncLock(root, { pid: 100, isAlive: () => true });

    const taken = await acquireSyncLock(root, { pid: 200, isAlive: () => false });

    expect(taken).not.toBeNull();
    expect(JSON.parse(readFileSync(syncLockPath(root), "utf-8")).pid).toBe(200);
  });

  it("takes over a lock older than the stale window even when the pid looks alive", async () => {
    // A recycled pid can make a dead holder look live forever — the age is the
    // second net under the liveness probe.
    const now = Date.now();
    await acquireSyncLock(root, { pid: 100, isAlive: () => true, now: () => now });

    const taken = await acquireSyncLock(root, {
      pid: 200,
      isAlive: () => true,
      now: () => now + SYNC_LOCK_STALE_MS + 1,
    });

    expect(taken).not.toBeNull();
  });

  it("takes over an unparseable lock left by a crash mid-write", async () => {
    writeFileSync(syncLockPath(root), "{ truncated");

    const taken = await acquireSyncLock(root, { pid: 7, isAlive: () => true });

    expect(taken).not.toBeNull();
  });

  it("removes the lock on release, freeing it for the next run", async () => {
    const lock = await acquireSyncLock(root, { pid: 100, isAlive: () => true });
    await lock!.release();

    expect(existsSync(syncLockPath(root))).toBe(false);
    expect(await acquireSyncLock(root, { pid: 200, isAlive: () => true })).not.toBeNull();
  });

  it("leaves the lock alone on release when another run has taken it over", async () => {
    const ours = await acquireSyncLock(root, { pid: 100, isAlive: () => true });
    // Our holder was declared dead and pid 200 took over.
    await acquireSyncLock(root, { pid: 200, isAlive: () => false });

    await ours!.release();

    expect(existsSync(syncLockPath(root))).toBe(true);
    expect(JSON.parse(readFileSync(syncLockPath(root), "utf-8")).pid).toBe(200);
  });

  it("is safe to release twice", async () => {
    const lock = await acquireSyncLock(root, { pid: 100 });
    await lock!.release();
    await lock!.release();
    expect(existsSync(syncLockPath(root))).toBe(false);
  });
});
