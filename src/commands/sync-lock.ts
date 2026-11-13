import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

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

export interface LockRecord {
  pid: number;
  at: number;
  /** Distinguishes two acquisitions by the same pid. Absent in locks written by older versions. */
  id?: string;
}

/** Absolute path of a project's sync lock. */
export function syncLockPath(root: string): string {
  return join(root, ".project-brain", "sync.lock");
}

/**
 * Signal 0 asks the kernel whether the process exists without delivering
 * anything. EPERM means it exists and belongs to another user — still alive.
 *
 * Exported so sync-status.ts's crashed-detection can reuse this exact probe
 * instead of maintaining a second copy that could drift from it.
 */
export function defaultIsAlive(pid: number): boolean {
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
 * Read the current lock holder for display purposes (e.g. the "sync already
 * running" skip message). Never use this to decide whether to take the lock
 * over — that staleness/liveness judgment belongs to acquireSyncLock alone.
 */
export async function readLockHolder(root: string): Promise<LockRecord | null> {
  return readRecord(syncLockPath(root));
}

/** Read any pid-file lock's holder, for display only. */
export async function readPidFileLockHolder(path: string): Promise<LockRecord | null> {
  return readRecord(path);
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
 * siblings — the same boundary `.project-brain/` already draws. The
 * machine-wide lock that serializes embedding across roots lives in
 * `embed-lock.ts` and is built on the same primitive.
 */
export async function acquireSyncLock(
  root: string,
  opts: AcquireSyncLockOptions = {}
): Promise<SyncLock | null> {
  return acquirePidFileLock(syncLockPath(root), opts);
}

export interface PidFileLock extends SyncLock {
  /** Re-stamp the lock's age, so a holder that keeps working never reads as abandoned. */
  refresh(): Promise<void>;
}

export interface AcquirePidFileLockOptions extends AcquireSyncLockOptions {
  /** Age past which the lock is abandoned whatever the liveness probe says. */
  staleMs?: number;
}

/** A lock file that never parses is only abandoned once it is this old. */
const GARBAGE_GRACE_MS = 5_000;
/** A takeover sentinel is held for milliseconds; one this old belongs to a crashed taker. */
const SENTINEL_STALE_MS = 10_000;
const MAX_ATTEMPTS = 4;

type LockState =
  | { kind: "missing" }
  | { kind: "garbage"; mtimeMs: number }
  | { kind: "held"; record: LockRecord };

async function readState(path: string): Promise<LockState> {
  let text: string;
  let mtimeMs: number;
  try {
    [text, mtimeMs] = await Promise.all([readFile(path, "utf-8"), stat(path).then((s) => s.mtimeMs)]);
  } catch {
    return { kind: "missing" };
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.pid === "number" && typeof parsed?.at === "number") {
      return { kind: "held", record: parsed as LockRecord };
    }
  } catch {
    // fall through
  }
  return { kind: "garbage", mtimeMs };
}

const sameRecord = (a: LockRecord | null, b: LockRecord | null): boolean =>
  a === null || b === null ? a === b : a.pid === b.pid && a.at === b.at && a.id === b.id;

/**
 * Publish `record` at `target` only if nothing is there. The record is written
 * to a private temp file first and hard-linked into place, so the lock path
 * never exists half-written: any reader sees either no file or a full record.
 */
async function linkRecord(target: string, record: LockRecord): Promise<boolean> {
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(record));
  try {
    await link(tmp, target);
    return true;
  } catch {
    return false;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Remove `target` only if it still holds `expected`. The file is renamed aside
 * first, so exactly one remover can move it, and what was moved is checked
 * before it is discarded. A mismatch is put back with `link`, which never
 * overwrites a newer file.
 */
async function removeIfStill(target: string, expected: LockRecord | null): Promise<void> {
  const aside = `${target}.${randomUUID()}.aside`;
  if (!(await rename(target, aside).then(() => true, () => false))) return;
  const moved = await readState(aside);
  const movedRecord = moved.kind === "held" ? moved.record : null;
  if (!sameRecord(movedRecord, expected)) await link(aside, target).catch(() => {});
  await unlink(aside).catch(() => {});
}

/**
 * Exclusive lock file recording its holder's pid. A holder that died, or a
 * record older than `staleMs`, is taken over.
 *
 * Correctness rests on three rules:
 * - The lock appears atomically and complete (`linkRecord`), so a contender
 *   that reads nothing has seen a release, never a half-written holder, and
 *   simply retries the create.
 * - Only a taker holding the `<path>.takeover` sentinel ever removes someone
 *   else's lock, and it re-reads the record under the sentinel first. Without
 *   the sentinel, two takers that both judged the same dead holder raced each
 *   other's delete-and-create and both came away holding the lock.
 * - Holders release and refresh only a record carrying their own id.
 */
export async function acquirePidFileLock(
  path: string,
  opts: AcquirePidFileLockOptions = {}
): Promise<PidFileLock | null> {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? SYNC_LOCK_STALE_MS;
  const id = randomUUID();
  const sentinel = `${path}.takeover`;

  await mkdir(dirname(path), { recursive: true });

  const isAbandoned = (state: LockState): boolean => {
    if (state.kind === "missing") return false;
    if (state.kind === "garbage") return now() - state.mtimeMs > GARBAGE_GRACE_MS;
    return !isAlive(state.record.pid) || now() - state.record.at > staleMs;
  };

  const acquireSentinel = async (): Promise<LockRecord | null> => {
    const mine: LockRecord = { pid, at: now(), id: randomUUID() };
    if (await linkRecord(sentinel, mine)) return mine;
    const held = await readState(sentinel);
    const crashed =
      held.kind === "garbage" ||
      (held.kind === "held" && (now() - held.record.at > SENTINEL_STALE_MS || !isAlive(held.record.pid)));
    if (!crashed) return null;
    await removeIfStill(sentinel, held.kind === "held" ? held.record : null);
    return (await linkRecord(sentinel, mine)) ? mine : null;
  };

  /** Clear an abandoned lock under the sentinel. False when another taker is mid-takeover. */
  const clearAbandoned = async (): Promise<boolean> => {
    const token = await acquireSentinel();
    if (!token) return false;
    try {
      const state = await readState(path);
      if (isAbandoned(state)) await removeIfStill(path, state.kind === "held" ? state.record : null);
      return true;
    } finally {
      const held = await readState(sentinel);
      if (held.kind === "held" && sameRecord(held.record, token)) await unlink(sentinel).catch(() => {});
    }
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (await linkRecord(path, { pid, at: now(), id })) return handle(path, pid, id, now);
    const state = await readState(path);
    if (state.kind === "missing") continue; // released between our create and our read
    if (!isAbandoned(state)) return null;
    if (!(await clearAbandoned())) return null;
  }
  return null;
}

function handle(path: string, pid: number, id: string, now: () => number): PidFileLock {
  const ours = async (): Promise<boolean> => {
    const state = await readState(path);
    return state.kind === "held" && state.record.pid === pid && state.record.id === id;
  };
  return {
    async release() {
      // Only ours to remove. A run that declared us dead and took the lock
      // over owns it now, and unlinking it would strand that run unprotected.
      if (await ours()) await unlink(path).catch(() => {});
    },
    async refresh() {
      if (!(await ours())) return;
      // Rename over the lock, so readers never see it truncated.
      const tmp = `${path}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify({ pid, at: now(), id } satisfies LockRecord))
        .then(() => rename(tmp, path))
        .catch(() => unlink(tmp).catch(() => {}));
    },
  };
}
