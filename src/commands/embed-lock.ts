import { createHash } from "node:crypto";
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
export async function markEmbedPending(dataDir: string, root: string, now: () => number = Date.now): Promise<void> {
  await mkdir(pendingDir(dataDir), { recursive: true });
  await writeFile(pendingFile(dataDir, root), JSON.stringify({ root, at: now() }));
}

/**
 * Claim every pending root. Each marker is renamed before it is read, so two
 * drainers never both run the same root, and a marker written after the claim
 * survives for the next round.
 */
export async function drainEmbedPending(dataDir: string): Promise<string[]> {
  const dir = pendingDir(dataDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  const roots = new Set<string>();
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const claimed = join(dir, `${name}.${process.pid}.claimed`);
    if (!(await rename(join(dir, name), claimed).then(() => true, () => false))) continue;
    try {
      const parsed = JSON.parse(await readFile(claimed, "utf-8"));
      if (typeof parsed?.root === "string" && parsed.root !== "") roots.add(parsed.root);
    } catch {
      // A torn marker carries no root to run.
    } finally {
      await unlink(claimed).catch(() => {});
    }
  }
  return [...roots];
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
}

/**
 * Run `run(root)` under the machine-wide embed lock, then drain the roots that
 * coalesced behind it. The lock is held across the drain and re-stamped before
 * each run, so a long queue never ages into looking abandoned.
 */
export async function runWithEmbedLock(opts: RunWithEmbedLockOptions): Promise<EmbedRunOutcome> {
  let lock = await acquireEmbedLock(opts);
  if (!lock) {
    if (opts.coalesce) {
      await markEmbedPending(opts.dataDir, opts.root, opts.now);
      // Re-check: the holder may have drained and released between our failed
      // acquire and the marker landing, which would strand the marker.
      lock = await acquireEmbedLock(opts);
      if (!lock) return { kind: "queued", holder: await readEmbedLockHolder(opts.dataDir) };
      await unlink(pendingFile(opts.dataDir, opts.root)).catch(() => {}); // we run it now
    } else {
      lock = await waitForEmbedLock(opts);
      if (!lock) return { kind: "timeout", holder: await readEmbedLockHolder(opts.dataDir) };
    }
  }

  const drained: string[] = [];
  try {
    const exitCode = await opts.run(opts.root, opts.coalesce);
    for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
      const roots = await drainEmbedPending(opts.dataDir);
      if (roots.length === 0) break;
      for (const root of roots) {
        await lock.refresh();
        drained.push(root);
        try {
          await (opts.runPending ? opts.runPending(root) : opts.run(root, true));
        } catch {
          // Someone else's root failing must not fail the run that drained it.
        }
      }
    }
    return { kind: "ran", exitCode, drained };
  } finally {
    await lock.release();
  }
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
