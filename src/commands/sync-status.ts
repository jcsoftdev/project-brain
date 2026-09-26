import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { defaultIsAlive, type LockRecord } from "./sync-lock.js";

/**
 * Repo-relative pointer to the hook's captured output, quoted verbatim in
 * every message that points a user at it (the skip message, the CLI's "Last
 * sync" line, and the post-commit hook's own redirect target) so the three
 * never drift apart.
 */
export const SYNC_LOG_RELATIVE_PATH = ".project-brain/sync.log";

/** Terminal outcomes a sync run itself can persist. */
export type PersistedSyncOutcome = "running" | "ok" | "aborted" | "failed";

/** Everything readSyncStatus can report, including the reader-derived "crashed". */
export type SyncOutcome = PersistedSyncOutcome | "crashed";

/** What a sync run writes to disk as it starts, finishes, aborts, or throws. */
export interface SyncStatusRecord {
  outcome: PersistedSyncOutcome;
  /** Holder pid — the same identity the sync lock records. */
  pid: number;
  startedAt: number;
  /** Whether this run was `--changed-only`. */
  changedOnly: boolean;
  /** How the run was launched (e.g. "post-commit-hook"), when known. */
  trigger?: string;
  finishedAt?: number;
  /** Files touched this run. Only set on `ok`. */
  files?: number;
  /** Chunks in the store after this run. Only set on `ok`. */
  chunks?: number;
  /** Set on `aborted` and `failed`. */
  error?: string;
}

/** readSyncStatus's result: the stored record, with `crashed` folded in live. */
export interface SyncStatusReport extends Omit<SyncStatusRecord, "outcome"> {
  outcome: SyncOutcome;
}

/** Absolute path of a project's sync status file. */
export function syncStatusPath(root: string): string {
  return join(root, ".project-brain", "sync-status.json");
}

/**
 * Persist a sync status record. Best-effort: a status write must never fail
 * the sync it is reporting on, so every error here is swallowed rather than
 * propagated.
 *
 * Writes to a temp file and renames into place — the same atomic-ish pattern
 * used elsewhere in this project — so a reader never observes a half-written
 * file even if the process dies mid-write.
 */
export async function writeSyncStatus(root: string, record: SyncStatusRecord): Promise<void> {
  try {
    const dir = join(root, ".project-brain");
    await mkdir(dir, { recursive: true });
    const path = syncStatusPath(root);
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(record));
    await rename(tmp, path);
  } catch {
    // Swallowed on purpose — see the doc comment above.
  }
}

/**
 * Synchronous counterpart to {@link writeSyncStatus}, for the one caller that
 * cannot await anything: the watchdog's onExpire calls `process.exit()`
 * immediately after, leaving no further event-loop turn for an async write
 * to land. Also best-effort — same swallow-on-purpose reasoning.
 */
export function writeSyncStatusSync(root: string, record: SyncStatusRecord): void {
  try {
    mkdirSync(join(root, ".project-brain"), { recursive: true });
    writeFileSync(syncStatusPath(root), JSON.stringify(record));
  } catch {
    // Swallowed on purpose — see writeSyncStatus.
  }
}

/**
 * Read the last recorded sync status, if any.
 *
 * A `running` record whose pid is no longer alive means the process died
 * without reaching any of its own terminal writes (`ok`, `aborted`, or
 * `failed` all update the file before exiting normally) — most likely killed
 * outright (OOM, SIGKILL, a crashed machine). Reported as `crashed` rather
 * than left as a stale `running` that would otherwise look like a sync still
 * in progress forever.
 */
export async function readSyncStatus(
  root: string,
  isAlive: (pid: number) => boolean = defaultIsAlive
): Promise<SyncStatusReport | null> {
  try {
    const parsed = JSON.parse(await readFile(syncStatusPath(root), "utf-8")) as Partial<SyncStatusRecord>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "number" ||
      typeof parsed.outcome !== "string"
    ) {
      return null;
    }

    const outcome: SyncOutcome =
      parsed.outcome === "running" && !isAlive(parsed.pid) ? "crashed" : parsed.outcome;

    return { ...(parsed as SyncStatusRecord), outcome };
  } catch {
    // Missing, unreadable, or a crash mid-write — nothing to report.
    return null;
  }
}

/** Largest-unit "Ns"/"Nm"/"Nh" age label, without seconds cluttering a minutes-or-longer age. */
function formatAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  return `${Math.round(totalMinutes / 60)}h`;
}

/**
 * The "A sync is already running..." message printed when acquireSyncLock
 * hands back null. Named with the holder's pid and age so a user staring at
 * a hung terminal knows whether to wait it out or go kill something.
 */
export function formatSkipMessage(
  projectId: string,
  holder: LockRecord | null,
  now: number = Date.now()
): string {
  const detail = holder
    ? ` (pid ${holder.pid}, started ${formatAge(now - holder.at)} ago)`
    : "";
  return (
    `A sync is already running for ${projectId}${detail} — skipping this one. ` +
    `Its output is in ${SYNC_LOG_RELATIVE_PATH}.`
  );
}

/**
 * The "Last sync: ..." line for `project-brain health` and check_health.
 * Each outcome surfaces exactly the detail that matters for it: what
 * finished, how long a wedged run ran before the watchdog gave up, or which
 * pid died mid-sync — always pointing at the log for anything short of a
 * clean `ok`.
 */
export function formatLastSyncLine(report: SyncStatusReport, now: number = Date.now()): string {
  switch (report.outcome) {
    case "ok": {
      const reference = report.finishedAt ?? report.startedAt;
      const duration =
        report.finishedAt !== undefined ? ` (${formatAge(report.finishedAt - report.startedAt)})` : "";
      return `ok, ${formatAge(now - reference)} ago — ${report.files ?? 0} files, ${report.chunks ?? 0} chunks${duration}`;
    }
    case "aborted": {
      const reference = report.finishedAt ?? report.startedAt;
      const durationSeconds =
        report.finishedAt !== undefined ? Math.round((report.finishedAt - report.startedAt) / 1000) : 0;
      return `aborted after ${durationSeconds}s, ${formatAge(now - reference)} ago — see ${SYNC_LOG_RELATIVE_PATH}`;
    }
    case "failed": {
      const reference = report.finishedAt ?? report.startedAt;
      const errorSuffix = report.error ? ` — ${report.error}` : "";
      return `failed ${formatAge(now - reference)} ago${errorSuffix} — see ${SYNC_LOG_RELATIVE_PATH}`;
    }
    case "crashed":
      return `crashed (pid ${report.pid} died mid-run), started ${formatAge(now - report.startedAt)} ago — see ${SYNC_LOG_RELATIVE_PATH}`;
    case "running":
      return `running (pid ${report.pid}), started ${formatAge(now - report.startedAt)} ago`;
  }
}
