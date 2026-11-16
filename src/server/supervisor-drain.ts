// A worker that is finishing a sync on its way out says so with a marker file, so the supervisor
// waits for it instead of killing it partway through an index write. A file and not a signal:
// on Windows a signal ends the process at once, and the worker is already shutting down when it
// writes this, so its stdio may be closed too.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Set by the supervisor in each worker's environment: where that worker leaves its marker. */
export const DRAIN_DIR_ENV = "BRAIN_DRAIN_DIR";

const marker = (dir: string, pid: number) => join(dir, String(pid));

export function markDraining(dir: string, pid: number): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker(dir, pid), String(Date.now()));
  } catch {
    /* without the marker the supervisor falls back to its short grace period */
  }
}

export function clearDraining(dir: string, pid: number): void {
  try {
    rmSync(marker(dir, pid), { force: true });
  } catch {
    /* the supervisor clears it again when the worker exits */
  }
}

/** Only asked about the supervisor's own live children, so a stale file cannot name a recycled pid. */
export function isDraining(dir: string, pid: number): boolean {
  return existsSync(marker(dir, pid));
}
