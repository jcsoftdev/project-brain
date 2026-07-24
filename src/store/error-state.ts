import { join } from "node:path";

export interface LastError {
  phase: string;
  message: string;
  timestamp: number;
}

const MAX_MESSAGE_LENGTH = 500;

function errorStatePath(dbPath: string, project: string): string {
  const safe = project.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 64);
  return join(dbPath, `${safe}.error.json`);
}

function toMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > MAX_MESSAGE_LENGTH ? raw.slice(0, MAX_MESSAGE_LENGTH) : raw;
}

/**
 * Persist the last infra-level failure for a project. Called from
 * last-resort catch blocks on fail-fast paths (the search hook, sync
 * setup) — must never throw, or a secondary failure here could turn a
 * fail-fast path into a hang.
 */
export async function writeLastError(
  dbPath: string,
  project: string,
  phase: string,
  error: unknown
): Promise<void> {
  try {
    const entry: LastError = { phase, message: toMessage(error), timestamp: Date.now() };
    await Bun.write(errorStatePath(dbPath, project), JSON.stringify(entry));
  } catch {
    // Never throw — see docstring.
  }
}

/** True when `value` has the exact shape of `LastError` (phase/message strings, numeric timestamp). */
function isLastError(value: unknown): value is LastError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.phase === "string" &&
    typeof v.message === "string" &&
    typeof v.timestamp === "number"
  );
}

/** Read the last recorded failure for a project, or null if none / unreadable / malformed. */
export async function readLastError(dbPath: string, project: string): Promise<LastError | null> {
  try {
    const f = Bun.file(errorStatePath(dbPath, project));
    if (!(await f.exists())) return null;
    const parsed: unknown = await f.json();
    return isLastError(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Clear the last recorded failure for a project — but ONLY when the stored
 * entry's phase matches. Storage holds a single entry per project (not
 * keyed by phase), so an unrelated phase succeeding must not wipe out a
 * still-live failure from a different phase.
 */
export async function clearLastError(dbPath: string, project: string, phase: string): Promise<void> {
  try {
    const existing = await readLastError(dbPath, project);
    if (!existing || existing.phase !== phase) return;
    const { unlink } = await import("node:fs/promises");
    await unlink(errorStatePath(dbPath, project));
  } catch {
    // Never throw — see writeLastError docstring.
  }
}
