/**
 * Wall-clock budget for one CLI sync job. A sync that has not finished within
 * it is not going to: the run is wedged on something the code below it cannot
 * cancel (an embedding backend that stopped answering, a model pull with no
 * timeout of its own), and every minute past this point it keeps its chunk
 * buffers resident for nothing.
 *
 * 30 minutes clears a cold full index of a large repository with room to spare,
 * while a `--changed-only` run that reaches it is certainly stuck.
 */
export const DEFAULT_SYNC_TIMEOUT_MS = 30 * 60 * 1000;

export interface SyncWatchdogOptions {
  /** Budget in milliseconds. 0 disables the watchdog entirely. */
  timeoutMs: number;
  /** Called once the budget elapses. */
  onExpire: () => void;
  /** Injectable for tests; defaults to setTimeout. The handle is opaque —
   * setTimeout's return type differs between the Node and DOM lib typings. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Injectable for tests; defaults to clearTimeout. */
  clearTimer?: (timer: unknown) => void;
}

/**
 * Resolve the budget from the environment. `BRAIN_SYNC_TIMEOUT_MS=0` turns the
 * watchdog off for anyone who indexes a repository large enough to need it.
 * Anything that is not a non-negative integer falls back to the default with a
 * warning — silently disabling the only guard against a hung job would be the
 * worst possible reading of a typo.
 */
export function resolveSyncTimeoutMs(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): number {
  const raw = env.BRAIN_SYNC_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_SYNC_TIMEOUT_MS;

  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.warn(
      `[sync] ignoring invalid BRAIN_SYNC_TIMEOUT_MS=${JSON.stringify(raw)} ` +
        `(must be a non-negative integer, 0 to disable); using default ${DEFAULT_SYNC_TIMEOUT_MS}`
    );
    return DEFAULT_SYNC_TIMEOUT_MS;
  }
  return n;
}

/**
 * Arm a wall-clock watchdog over a sync job. Returns a cancel function the
 * caller must invoke when the job finishes.
 *
 * The timer is unref'd: it must never be the reason a finished process stays
 * alive, only the reason a wedged one does not.
 */
export function startSyncWatchdog(opts: SyncWatchdogOptions): () => void {
  if (opts.timeoutMs <= 0) return () => {};

  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((timer: unknown) => clearTimeout(timer as Parameters<typeof clearTimeout>[0]));

  const timer = setTimer(opts.onExpire, opts.timeoutMs);
  (timer as { unref?: () => void }).unref?.();

  return () => clearTimer(timer);
}
