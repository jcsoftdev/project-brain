/**
 * Which project-brain version each running Claude Code session started on.
 *
 * After `project-brain update`, hooks and skills are live in sessions that were already open, but
 * CLAUDE.md is only read at launch, so those sessions keep the old routing guidance and never
 * learn anything changed. SessionStart records the version here; the first prompt afterwards that
 * runs a newer binary gets one notice (see commands/suggest.ts) and is marked notified.
 *
 * One small file per session under `<dataDir>/sessions/`, written atomically. Two sessions never
 * share a file, so marking one notified cannot undo another's SessionStart record (a shared file
 * rewritten read-modify-write did exactly that), and the prompt hook reads one tiny file.
 */
import { join } from "node:path";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { writeFileAtomic } from "../atomic-write.js";
import { isNewer } from "../notifier.js";

const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionEntry {
  version: string;
  /** When SessionStart recorded it (epoch ms). */
  at: number;
  notified?: boolean;
}

export interface SwapRecord {
  /** The server's working directory, which is the project the host opened it for. */
  cwd: string;
  from: string;
  to: string;
  at: number;
}

const sessionsDir = (dataDir: string) => join(dataDir, "sessions");
// A session id is the host's, so it is made safe to use as a file name rather than trusted to be.
const sessionFile = (dataDir: string, id: string) => join(sessionsDir(dataDir), `${id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120)}.json`);
const swapsFile = (dataDir: string) => join(dataDir, "mcp-swaps.json");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function pruneOld(dataDir: string, now: number): Promise<void> {
  const dir = sessionsDir(dataDir);
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const file = join(dir, name);
    const at = (await readJson<Partial<SessionEntry>>(file, {})).at ?? (await stat(file).then((s) => s.mtimeMs, () => now));
    if (now - at >= RETAIN_MS) await rm(file, { force: true }).catch(() => {});
  }
}

/** Remember the version a session started on. A repeat SessionStart (resume, compact) replaces it: CLAUDE.md just reloaded. */
export async function recordSession(
  dataDir: string,
  sessionId: string,
  version: string,
  now: number = Date.now()
): Promise<void> {
  const entry: SessionEntry = { version, at: now };
  await writeFileAtomic(sessionFile(dataDir, sessionId), `${JSON.stringify(entry)}\n`);
  await pruneOld(dataDir, now);
}

export interface UpgradeNotice {
  from: string;
  since: number;
  /** Mark it delivered. Call after the notice was written out, so a failure repeats it rather than losing it. */
  commit: () => Promise<void>;
}

/**
 * The version this session started on, if the running binary is newer and it was not told yet.
 * An unknown session costs one small read and nothing else.
 */
export async function takeUpgradeNotice(
  dataDir: string,
  sessionId: string,
  currentVersion: string
): Promise<UpgradeNotice | null> {
  const file = sessionFile(dataDir, sessionId);
  const entry = await readJson<SessionEntry | null>(file, null);
  if (!entry || entry.notified || typeof entry.version !== "string" || !isNewer(currentVersion, entry.version)) return null;
  return {
    from: entry.version,
    since: entry.at,
    commit: () => writeFileAtomic(file, `${JSON.stringify({ ...entry, notified: true })}\n`),
  };
}

/** Called by the supervisor after it hands its client to a newer binary. */
export async function recordSwap(dataDir: string, swap: SwapRecord): Promise<void> {
  const prior = await readJson<SwapRecord[]>(swapsFile(dataDir), []);
  const kept = prior.filter((s) => swap.at - s.at < RETAIN_MS).slice(-49);
  await writeFileAtomic(swapsFile(dataDir), `${JSON.stringify([...kept, swap], null, 2)}\n`);
}

/** Whether a server in this project swapped to `version` after the session began. */
export async function serverSwapped(dataDir: string, cwd: string | undefined, version: string, since: number): Promise<boolean> {
  if (!cwd) return false;
  const swaps = await readJson<SwapRecord[]>(swapsFile(dataDir), []);
  return swaps.some((s) => s.to === version && s.at >= since && (cwd === s.cwd || cwd.startsWith(`${s.cwd}/`)));
}
