import { join } from "node:path";
import { mkdir, open, readFile, unlink } from "node:fs/promises";

/**
 * A lock older than this is abandoned regardless of what the liveness probe
 * says. It is the second net under the pid check, for the case that check
 * cannot cover: an operating system that recycled the holder's pid onto an
 * unrelated process, which would otherwise keep a dead run's lock alive
 * forever. It must comfortably exceed the longest legitimate sync, so it is
 * pinned to twice the job's own wall-clock budget.
 */
export const SYNC_LOCK_STALE_MS = 60 * 60 * 1000;

export interface SyncLock {
  /** Remove the lock, unless another run has already taken it over. */
  release(): Promise<void>;
}

export interface AcquireSyncLockOptions {
  /** Holder pid recorded in the lock. Defaults to this process. */
  pid?: number;
  /** Liveness probe for the recorded holder. Injectable for tests. */
  isAlive?: (pid: number) => boolean;
  /** Clock, injectable for tests. */
  now?: () => number;
}

interface LockRecord {
  pid: number;
  at: number;
}

/** Absolute path of a project's sync lock. */
export function syncLockPath(root: string): string {
  return join(root, ".project-brain", "sync.lock");
}

/**
 * Signal 0 asks the kernel whether the process exists without delivering
 * anything. EPERM means it exists and belongs to another user — still alive.
 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function readRecord(path: string): Promise<LockRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    if (typeof parsed?.pid !== "number" || typeof parsed?.at !== "number") return null;
    return parsed as LockRecord;
  } catch {
    // Missing, unreadable, or a crash mid-write — nothing to honour.
    return null;
  }
}

/**
 * Cross-process single-flight lock for a project's sync, held as a file under
 * `.project-brain/`.
 *
 * Returns a handle, or null when a live run already holds it — in which case
 * the caller must SKIP its own sync rather than queue behind it. Skipping is
 * correct: the holder is about to index the same working tree, so a second run
 * would repeat its work. The post-commit hook spawns a sync per commit,
 * detached, and without this every commit during a slow run stacked another
 * full-memory job on top of the last.
 *
 * Scoping is per project root, so a worktree locks independently of its
 * siblings — the same boundary `.project-brain/` already draws.
 */
export async function acquireSyncLock(
  root: string,
  opts: AcquireSyncLockOptions = {}
): Promise<SyncLock | null> {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const now = opts.now ?? Date.now;
  const path = syncLockPath(root);

  const write = async () => {
    await mkdir(join(root, ".project-brain"), { recursive: true });
    // `wx` fails when the file exists — the atomic test-and-set this needs.
    const handle = await open(path, "wx");
    await handle.writeFile(JSON.stringify({ pid, at: now() } satisfies LockRecord));
    await handle.close();
  };

  try {
    await write();
  } catch {
    const held = await readRecord(path);
    const stale =
      held === null || !isAlive(held.pid) || now() - held.at > SYNC_LOCK_STALE_MS;
    if (!stale) return null;

    try {
      await unlink(path);
      await write();
    } catch {
      return null; // lost the race to another taker
    }
  }

  return {
    async release() {
      // Only ours to remove. A run that declared us dead and took the lock
      // over owns it now, and unlinking it would strand that run unprotected.
      const held = await readRecord(path);
      if (held?.pid !== pid) return;
      await unlink(path).catch(() => {});
    },
  };
}
