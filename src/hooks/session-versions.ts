/**
 * Which project-brain version each running Claude Code session started on.
 *
 * After `project-brain update`, hooks and skills are live in sessions that were already open, but
 * CLAUDE.md is only read at launch, so those sessions keep the old routing guidance and never
 * learn anything changed. SessionStart records the version here; the first prompt afterwards that
 * runs a newer binary gets one notice (see commands/suggest.ts) and is marked notified.
 *
 * One small JSON file, rewritten atomically. Two sessions starting in the same instant can lose
 * one entry to a read-modify-write race; the cost is a missed notice, never a wrong one.
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../atomic-write.js";
import { isNewer } from "../notifier.js";

const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionEntry {
  version: string;
  /** When SessionStart recorded it (epoch ms). */
  at: number;
  notified?: boolean;
}

type SessionVersions = Record<string, SessionEntry>;

export interface SwapRecord {
  /** The server's working directory, which is the project the host opened it for. */
  cwd: string;
  from: string;
  to: string;
  at: number;
}

const sessionsFile = (dataDir: string) => join(dataDir, "session-versions.json");
const swapsFile = (dataDir: string) => join(dataDir, "mcp-swaps.json");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function pruned(all: SessionVersions, now: number): SessionVersions {
  return Object.fromEntries(
    Object.entries(all).filter(([, e]) => e && typeof e.version === "string" && now - e.at < RETAIN_MS)
  );
}

/** Remember the version a session started on. A repeat SessionStart (resume, compact) replaces it: CLAUDE.md just reloaded. */
export async function recordSession(
  dataDir: string,
  sessionId: string,
  version: string,
  now: number = Date.now()
): Promise<void> {
  const all = pruned(await readJson<SessionVersions>(sessionsFile(dataDir), {}), now);
  all[sessionId] = { version, at: now };
  await writeFileAtomic(sessionsFile(dataDir), `${JSON.stringify(all, null, 2)}\n`);
}

/**
 * The version this session started on, once, if the running binary is newer. Marks it notified
 * before returning, so a failed write means no notice rather than a notice on every prompt.
 * An unknown session costs one small read and nothing else.
 */
export async function takeUpgradeNotice(
  dataDir: string,
  sessionId: string,
  currentVersion: string,
  now: number = Date.now()
): Promise<{ from: string; since: number } | null> {
  const all = await readJson<SessionVersions>(sessionsFile(dataDir), {});
  const entry = all[sessionId];
  if (!entry || entry.notified || !isNewer(currentVersion, entry.version)) return null;
  all[sessionId] = { ...entry, notified: true };
  try {
    await writeFileAtomic(sessionsFile(dataDir), `${JSON.stringify(pruned(all, now), null, 2)}\n`);
  } catch {
    return null;
  }
  return { from: entry.version, since: entry.at };
}

/** Called by the MCP server after it hands its client to a newer binary. */
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
