import { join } from "node:path";
import { open, unlink } from "node:fs/promises";

/** Lock file name, inside the project's own `.project-brain/` directory. */
export const WATCH_LOCK_FILE = "watch.lock";

/** What a caller gets when it wins the election. */
export interface WatchLockHandle {
  /** Idempotent: safe to call from both stop() and the shutdown handler. */
  release(): Promise<void>;
}

interface AcquireOptions {
  /**
   * Liveness test for the recorded holder. Injected for tests; the default
   * asks the OS.
   */
  isAlive?: (pid: number) => boolean;
}

/**
 * Whether a pid names a live process.
 *
 * Signal 0 performs the existence and permission check without delivering
 * anything — the same test the server already uses to notice its client is
 * gone.
 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Elect ONE watcher per project root, across processes.
 *
 * Every MCP host spawns its own `serve`, and several sitting in one repo is
 * ordinary. Each started its own FileWatcher on the same root, so one file save
 * became N independent syncs — N embed passes over identical content, N writes,
 * and N sets of fragments for optimize to clean up. Measured with two watchers
 * on one root and a single file written: 2 syncs, 2 batchReplace calls.
 *
 * Returns a handle to the winner and null to everyone else, who then simply do
 * not watch. Serving is unaffected — the watcher was always optional.
 *
 * WHY LIVENESS AND NOT AGE. The optimize lock next door decides abandonment by
 * age, which works because an optimize is a bounded operation. This lock is
 * held for as long as the process runs, so age answers the wrong question: a
 * healthy watcher legitimately holds it for days and would keep "expiring".
 * The recorded pid being gone is the fact that actually means abandoned.
 *
 * The residual risk is pid reuse — the OS hands the dead holder's number to an
 * unrelated process, liveness says yes, and nobody takes the root over. Its
 * cost is bounded (that root goes unwatched until some process restarts and
 * finds the lock genuinely free) and no data is lost, since a full sync
 * reconciles against the manifest. Guarding it would mean recording and
 * re-reading process start times per platform, which is not worth carrying for
 * a case whose worst outcome is a stale index on one root.
 */
export async function acquireWatchLock(
  root: string,
  opts: AcquireOptions = {}
): Promise<WatchLockHandle | null> {
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const lockPath = join(root, ".project-brain", WATCH_LOCK_FILE);

  const write = async () => {
    // `wx` fails when the file exists — the atomic test-and-set this needs.
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
    await handle.close();
  };

  const makeHandle = (): WatchLockHandle => ({
    release: async () => {
      await unlink(lockPath).catch(() => {});
    },
  });

  try {
    await write();
    return makeHandle();
  } catch {
    // Either held by someone, or the directory does not exist. Read it to find
    // out which — a missing/unreadable file is not the same as a live holder.
  }

  let raw: string;
  try {
    raw = await Bun.file(lockPath).text();
  } catch {
    // No lock to inspect, so the create above failed for another reason —
    // most likely there is no .project-brain/ directory. Not our job to make
    // one; the caller has no project here to watch.
    return null;
  }

  let holder: number | null = null;
  try {
    const pid = JSON.parse(raw)?.pid;
    holder = typeof pid === "number" ? pid : null;
  } catch {
    // Unparseable — a crash midway through the write. Refusing to watch
    // forever over a truncated file is worse than taking it over.
    holder = null;
  }

  if (holder !== null && isAlive(holder)) return null;

  try {
    await unlink(lockPath);
    await write();
  } catch {
    return null; // lost the race to another taker
  }
  return makeHandle();
}
