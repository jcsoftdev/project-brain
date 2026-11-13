import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  acquirePidFileLock,
  readPidFileLockHolder,
  type LockRecord,
  type PidFileLock,
} from "./sync-lock.js";

/**
 * Machine-wide single-flight for embedding work: `sync`, `init` and `reindex`.
 *
 * Every worktree has its own per-root sync lock, but they all embed through the
 * one default Ollama. Measured with several worktrees syncing at once, each run
 * sent 64-chunk batches at ~5.5 s per batch to that single server, so N runs
 * took N times as long each and kept the machine's load high the whole time —
 * running them one after another finishes the same work no later.
 *
 * Two ways to meet a held lock, chosen by who is asking:
 *
 * - A hook-triggered `sync --changed-only` COALESCES: it records its root as
 *   pending and exits at once. The holder, before releasing, re-runs one
 *   changed-only sync per pending root. A burst of commits across worktrees
 *   becomes at most one queued run per root instead of a pile of waiters.
 * - A person running `sync`, `init` or `reindex` WAITS, bounded, with a single
 *   line saying who holds the lock. Exiting would surprise someone who asked
 *   for an index now; waiting forever would hide a wedged holder.
 */
export const EMBED_LOCK_FILE = "embed.lock";
export const EMBED_PENDING_DIR = "embed-pending";

/** Longest a foreground run waits for the lock before giving up. */
export const EMBED_LOCK_WAIT_MS = 15 * 60_000;
const EMBED_LOCK_POLL_MS = 2_000;
/** Drain rounds the holder runs before leaving the rest to the next holder. */
const MAX_DRAIN_ROUNDS = 3;

export const embedLockPath = (dataDir: string): string => join(dataDir, EMBED_LOCK_FILE);
const pendingDir = (dataDir: string): string => join(dataDir, EMBED_PENDING_DIR);
const pendingFile = (dataDir: string, root: string): string =>
  join(pendingDir(dataDir), `${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);

export interface EmbedLockOptions {
  dataDir: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

export function acquireEmbedLock(opts: EmbedLockOptions): Promise<PidFileLock | null> {
  return acquirePidFileLock(embedLockPath(opts.dataDir), opts);
}

export function readEmbedLockHolder(dataDir: string): Promise<LockRecord | null> {
  return readPidFileLockHolder(embedLockPath(dataDir));
}

export interface WaitForEmbedLockOptions extends EmbedLockOptions {
  /** Upper bound on the wait. Defaults to BRAIN_EMBED_LOCK_WAIT_MS, else 15 minutes. */
  timeoutMs?: number;
  pollMs?: number;
  /** Called once, when the first attempt finds the lock held. */
  onWait?: (holder: LockRecord | null) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function resolveEmbedLockWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BRAIN_EMBED_LOCK_WAIT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : EMBED_LOCK_WAIT_MS;
}

/** Acquire the lock, polling until `timeoutMs`; null when it never came free. */
export async function waitForEmbedLock(opts: WaitForEmbedLockOptions): Promise<PidFileLock | null> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? resolveEmbedLockWaitMs();
  const pollMs = opts.pollMs ?? EMBED_LOCK_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  let announced = false;
  for (;;) {
    const lock = await acquireEmbedLock(opts);
    if (lock) return lock;
    if (!announced) {
      announced = true;
      opts.onWait?.(await readEmbedLockHolder(opts.dataDir));
    }
    if (now() >= deadline) return null;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

/** Record that `root` wants a changed-only sync once the current holder is done. */
export async function markEmbedPending(
  dataDir: string,
  root: string,
  now: () => number = Date.now
): Promise<PendingEntry> {
  await mkdir(pendingDir(dataDir), { recursive: true });
  const target = pendingFile(dataDir, root);
  // Written aside and renamed in, so a reader never sees a torn marker.
  const tmp = `${target}.${randomUUID()}.tmp`;
  const marker: PendingMarker = { root, at: now(), id: randomUUID() };
  await writeFile(tmp, JSON.stringify(marker));
  await rename(tmp, target);
  return { file: target, marker };
}

export interface PendingMarker {
  root: string;
  at: number;
  id: string;
}

export interface PendingEntry {
  file: string;
  marker: PendingMarker;
}

async function listPending(dataDir: string): Promise<PendingEntry[]> {
  const dir = pendingDir(dataDir);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
  const entries: PendingEntry[] = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const parsed = JSON.parse(await readFile(file, "utf-8"));
      if (typeof parsed?.root === "string" && parsed.root !== "") entries.push({ file, marker: parsed });
      else await unlink(file).catch(() => {});
    } catch {
      // Gone since the listing, or unreadable: nothing to run.
    }
  }
  return entries;
}

export async function hasEmbedPending(dataDir: string): Promise<boolean> {
  return (await readdir(pendingDir(dataDir)).catch(() => [] as string[])).some((n) => n.endsWith(".json"));
}

/**
 * Remove a marker after its run, unless the root was queued again meanwhile.
 * The file is moved aside before it is judged, so a newer marker that lands
 * during the check is never deleted; if the moved one turns out to be newer it
 * goes back, and overwriting a still-newer one loses nothing, since every
 * marker for a root asks for the same run.
 */
async function settlePending(entry: PendingEntry): Promise<void> {
  const aside = `${entry.file}.${randomUUID()}.settle`;
  if (!(await rename(entry.file, aside).then(() => true, () => false))) return;
  let moved: PendingMarker | null = null;
  try {
    moved = JSON.parse(await readFile(aside, "utf-8"));
  } catch {
    // unreadable: treat as ours
  }
  if (moved && moved.id !== entry.marker.id) await rename(aside, entry.file).catch(() => {});
  else await unlink(aside).catch(() => {});
}

/**
 * Run every pending root once, for up to MAX_DRAIN_ROUNDS rounds. Only the
 * embed-lock holder calls this, so no two drainers overlap. A marker is
 * removed after its root's run rather than before, so a holder that crashes
 * mid-drain leaves the rest queued for the next holder instead of losing them.
 */
async function drainPending(dataDir: string, runPending: (root: string) => Promise<number>): Promise<string[]> {
  const drained: string[] = [];
  for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
    const entries = await listPending(dataDir);
    if (entries.length === 0) break;
    for (const entry of entries) {
      drained.push(entry.marker.root);
      try {
        await runPending(entry.marker.root);
      } catch {
        // Someone else's root failing must not fail the run that drained it.
      }
      await settlePending(entry);
    }
  }
  return drained;
}

/** The roots still queued, for tests and display. */
export async function pendingEmbedRoots(dataDir: string): Promise<string[]> {
  return (await listPending(dataDir)).map((e) => e.marker.root);
}

/** How often a holder re-stamps the lock, for the whole hold. */
export const EMBED_LOCK_REFRESH_MS = 5 * 60_000;

/** Hold `lock` for `work`, re-stamping it on a timer so a long hold never reads as abandoned. */
async function holding<T>(lock: PidFileLock, refreshMs: number, work: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => void lock.refresh(), refreshMs);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await lock.release();
  }
}

export type EmbedRunOutcome =
  | { kind: "ran"; exitCode: number; drained: string[] }
  | { kind: "queued"; holder: LockRecord | null }
  | { kind: "timeout"; holder: LockRecord | null };

export interface RunWithEmbedLockOptions extends WaitForEmbedLockOptions {
  root: string;
  /** Hook-triggered incremental run: coalesce instead of waiting. */
  coalesce: boolean;
  /** The embedding work for one root. Resolves to its exit code. */
  run: (root: string, changedOnly: boolean) => Promise<number>;
  /** Runs a coalesced root's changed-only sync. Defaults to `run(root, true)`. */
  runPending?: (root: string) => Promise<number>;
  /** Lock re-stamp interval. Defaults to EMBED_LOCK_REFRESH_MS. */
  refreshMs?: number;
}

/**
 * Run `run(root)` under the machine-wide embed lock, then drain the roots that
 * coalesced behind it.
 *
 * A marker can land after the last drain and before the release. Its writer
 * then failed to take the lock only because we still held it, so after every
 * release the holder looks again and, if anything is queued, takes the lock
 * back and drains once more. Whoever wins that acquire owns the queue.
 */
export async function runWithEmbedLock(opts: RunWithEmbedLockOptions): Promise<EmbedRunOutcome> {
  let lock = await acquireEmbedLock(opts);
  if (!lock) {
    if (opts.coalesce) {
      const queued = await markEmbedPending(opts.dataDir, opts.root, opts.now);
      // Re-check: the holder may have released between our failed acquire and
      // the marker landing, and its post-release look may have missed it.
      lock = await acquireEmbedLock(opts);
      if (!lock) return { kind: "queued", holder: await readEmbedLockHolder(opts.dataDir) };
      await settlePending(queued); // we run it now
    } else {
      lock = await waitForEmbedLock(opts);
      if (!lock) return { kind: "timeout", holder: await readEmbedLockHolder(opts.dataDir) };
    }
  }

  const refreshMs = opts.refreshMs ?? EMBED_LOCK_REFRESH_MS;
  const runPending = opts.runPending ?? ((root: string) => opts.run(root, true));
  const drained: string[] = [];
  const exitCode = await holding(lock, refreshMs, async () => {
    const code = await opts.run(opts.root, opts.coalesce);
    drained.push(...(await drainPending(opts.dataDir, runPending)));
    return code;
  });

  while (await hasEmbedPending(opts.dataDir)) {
    const again = await acquireEmbedLock(opts);
    if (!again) break; // the new holder owns the queue now
    drained.push(...(await holding(again, refreshMs, () => drainPending(opts.dataDir, runPending))));
  }
  return { kind: "ran", exitCode, drained };
}

/** One line for a run that coalesced behind another. */
export function formatQueuedMessage(root: string, holder: LockRecord | null): string {
  return `sync: another project-brain run is embedding${formatHolder(holder)} — queued ${root}; it will sync when that run finishes.`;
}

/** One line for a foreground run that is about to wait. */
export function formatWaitMessage(holder: LockRecord | null, timeoutMs: number): string {
  return `Waiting for another project-brain run to finish embedding${formatHolder(holder)} (up to ${Math.round(timeoutMs / 60_000)} min; one embed at a time per machine)…`;
}

/** One line for a foreground run that gave up waiting. */
export function formatTimeoutMessage(holder: LockRecord | null): string {
  return `Error: another project-brain run is still embedding${formatHolder(holder)}. Retry when it finishes, or raise BRAIN_EMBED_LOCK_WAIT_MS.`;
}

function formatHolder(holder: LockRecord | null): string {
  return holder ? ` (pid ${holder.pid})` : "";
}
