import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWatchLock, WATCH_LOCK_FILE } from "../src/watcher-lock.js";

/**
 * One watcher per project root, elected across processes.
 *
 * Every MCP host starts its own `serve` process, and several of them sitting in
 * the same repo is normal rather than an edge case. Each one used to start its
 * own FileWatcher on the same root, so a single file save fanned out into N
 * independent syncs: N embed passes over identical content, N batchReplace
 * calls, N sets of fragments for optimize to clean up afterwards.
 *
 * Measured with two watchers on one root and one file written: 2 syncs, 2
 * batchReplace calls. The fix removes the duplication at its source — only the
 * elected process watches — rather than serialising the redundant work behind a
 * second lock.
 */
describe("acquireWatchLock", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pb-watchlock-"));
    await mkdir(join(root, ".project-brain"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const lockPath = () => join(root, ".project-brain", WATCH_LOCK_FILE);

  it("grants the lock to the first caller and records its pid", async () => {
    const handle = await acquireWatchLock(root);

    expect(handle).not.toBeNull();
    const raw = JSON.parse(await readFile(lockPath(), "utf8"));
    expect(raw.pid).toBe(process.pid);
  });

  it("refuses a second caller while the holder is alive", async () => {
    const first = await acquireWatchLock(root);
    expect(first).not.toBeNull();

    // The holder's pid is this very process, so any liveness check must see it.
    const second = await acquireWatchLock(root);

    expect(second).toBeNull();
  });

  it("takes the lock over when the recorded pid is gone", async () => {
    // A process killed without running its shutdown path leaves the file
    // behind. Age cannot decide this one: a healthy watcher legitimately holds
    // its lock for days, so "old" and "abandoned" are not the same question.
    // Liveness of the recorded pid is.
    await writeFile(lockPath(), JSON.stringify({ pid: 999999, at: Date.now() }));

    const handle = await acquireWatchLock(root, { isAlive: () => false });

    expect(handle).not.toBeNull();
    const raw = JSON.parse(await readFile(lockPath(), "utf8"));
    expect(raw.pid).toBe(process.pid);
  });

  it("treats an unparseable lock as abandoned", async () => {
    // A crash midway through the write leaves a truncated file. Refusing to
    // watch forever because of it would be worse than taking it over.
    await writeFile(lockPath(), "{not json");

    const handle = await acquireWatchLock(root);

    expect(handle).not.toBeNull();
  });

  it("frees the root for the next caller on release", async () => {
    const first = await acquireWatchLock(root);
    await first!.release();

    const second = await acquireWatchLock(root);

    expect(second).not.toBeNull();
  });

  it("is safe to release twice", async () => {
    // stop() and the shutdown handler can both reach it; the second call must
    // not throw on an already-deleted file.
    const handle = await acquireWatchLock(root);
    await handle!.release();
    await handle!.release();
  });

  it("returns null rather than throwing when the root has no .project-brain dir", async () => {
    // A cwd that is not an indexed project never gets this far in serve.ts, but
    // the lock must not be the thing that crashes the server if it does.
    const bare = await mkdtemp(join(tmpdir(), "pb-bare-"));
    try {
      expect(await acquireWatchLock(bare)).toBeNull();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
