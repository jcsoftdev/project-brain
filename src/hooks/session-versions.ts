/**
 * Which project-brain version each running Claude Code session started on.
 *
 * After `project-brain update`, hooks and skills are live in sessions that were already open, but
 * CLAUDE.md is only read at launch and the MCP server is not reloaded, so those sessions keep the old
 * routing guidance and the old tools and never learn anything changed. SessionStart records the
 * versions here; the first prompt afterwards that runs a newer binary gets one notice (see
 * commands/suggest.ts) and is marked notified.
 *
 * Two versions are kept apart because `/compact` and `/clear` reload CLAUDE.md but not the MCP server:
 * `version` is what the rules were last read at, `mcpVersion` is what the server started as.
 *
 * One small file per session under `<dataDir>/sessions/`, written atomically, and one per swap under
 * `<dataDir>/swaps/`. Nothing is shared, so concurrent writers cannot undo each other and the prompt
 * hook reads a single tiny file.
 */
import { join } from "node:path";
import { readFile, readdir, realpath, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { writeFileAtomic } from "../atomic-write.js";
import { isNewer } from "../notifier.js";

const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const MAX_SWAPS = 50;

export interface SessionEntry {
  /** The version CLAUDE.md was last loaded at (updated by compact/clear). */
  version: string;
  /** The version the MCP server started as; only a new Claude Code process changes it. */
  mcpVersion?: string;
  /** When the MCP server's version was recorded (epoch ms). */
  at: number;
  /** The binary version the user was last told about, so each update is announced once. */
  notifiedFor?: string;
}

export interface SwapRecord {
  /** The server's working directory (realpath), which is the project the host opened it for. */
  cwd: string;
  from: string;
  to: string;
  at: number;
}

const sessionsDir = (dataDir: string) => join(dataDir, "sessions");
const swapsDir = (dataDir: string) => join(dataDir, "swaps");
// A session id is the host's, so it is made safe to use as a file name rather than trusted to be.
const sessionFile = (dataDir: string, id: string) => join(sessionsDir(dataDir), `${id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120)}.json`);

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Drop entries older than a week. Decided from mtime alone, in parallel, and at most once a day
 * (a marker file), so SessionStart does not pay for a directory of thousands of sessions.
 */
async function pruneOld(dir: string, now: number, keep = Infinity): Promise<void> {
  const marker = join(dir, ".pruned");
  const last = await stat(marker).then((s) => s.mtimeMs, () => 0);
  if (now - last < PRUNE_EVERY_MS) return;
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
  const aged = await Promise.all(names.map(async (n) => ({ n, mtime: await stat(join(dir, n)).then((s) => s.mtimeMs, () => now) })));
  const newest = aged.sort((a, b) => b.mtime - a.mtime);
  await Promise.all(
    newest.filter((f, i) => now - f.mtime >= RETAIN_MS || i >= keep).map((f) => rm(join(dir, f.n), { force: true }).catch(() => {}))
  );
  await writeFile(marker, "").catch(() => {});
  await utimes(marker, new Date(now), new Date(now)).catch(() => {});
}

/**
 * Remember the versions a session started on.
 *
 * `/compact` and `/clear` fire SessionStart again in the SAME process: CLAUDE.md just reloaded, the MCP
 * server did not. So those update only the rules version and keep the server's. A new process
 * (startup, resume) starts everything fresh. With no `source` an existing session is assumed to be a
 * reload, which errs toward asking for a reconnect.
 */
export async function recordSession(
  dataDir: string,
  sessionId: string,
  version: string,
  now: number = Date.now(),
  source?: string
): Promise<void> {
  const file = sessionFile(dataDir, sessionId);
  const existing = await readJson<SessionEntry | null>(file, null);
  const sameProcess = existing !== null && (source === undefined ? true : source === "compact" || source === "clear");
  const entry: SessionEntry = sameProcess
    ? { ...existing!, version, mcpVersion: existing!.mcpVersion ?? existing!.version }
    : { version, mcpVersion: version, at: now };
  await writeFileAtomic(file, `${JSON.stringify(entry)}\n`);
  await pruneOld(sessionsDir(dataDir), now);
}

export interface UpgradeNotice {
  /** The version the session's MCP server is running. */
  from: string;
  since: number;
  /** CLAUDE.md in this session predates the update (it was not reloaded by /compact or /clear). */
  rulesStale: boolean;
  /** Mark it delivered. Call after the notice was written out, so a failure repeats it rather than losing it. */
  commit: () => Promise<void>;
}

/**
 * Something to tell this session, once per update, if its MCP server is older than the running binary.
 * An unknown session costs one small read and nothing else.
 */
export async function takeUpgradeNotice(
  dataDir: string,
  sessionId: string,
  currentVersion: string
): Promise<UpgradeNotice | null> {
  const file = sessionFile(dataDir, sessionId);
  const entry = await readJson<SessionEntry | null>(file, null);
  if (!entry || typeof entry.version !== "string") return null;
  const server = entry.mcpVersion ?? entry.version;
  if (!isNewer(currentVersion, server) || entry.notifiedFor === currentVersion) return null;
  return {
    from: server,
    since: entry.at,
    rulesStale: isNewer(currentVersion, entry.version),
    commit: async () => void (await writeFileAtomic(file, `${JSON.stringify({ ...entry, notifiedFor: currentVersion })}\n`)),
  };
}

const realOrSame = async (p: string) => realpath(p).catch(() => p);

/** Called by the supervisor after it hands its client to a newer binary. One file per swap: no shared write. */
export async function recordSwap(dataDir: string, swap: SwapRecord): Promise<void> {
  const dir = swapsDir(dataDir);
  await mkdir(dir, { recursive: true });
  const record: SwapRecord = { ...swap, cwd: await realOrSame(swap.cwd) };
  await writeFileAtomic(join(dir, `${swap.at}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`), `${JSON.stringify(record)}\n`);
  await pruneOld(dir, swap.at, MAX_SWAPS);
}

/** Whether the server for exactly this project directory swapped to `version` after the session began. */
export async function serverSwapped(dataDir: string, cwd: string | undefined, version: string, since: number): Promise<boolean> {
  if (!cwd) return false;
  const here = await realOrSame(cwd);
  const dir = swapsDir(dataDir);
  // The file name leads with the swap time, so older ones are skipped without being opened.
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json") && Number(n.split("-")[0]) >= since);
  const records = await Promise.all(names.map((n) => readJson<SwapRecord | null>(join(dir, n), null)));
  return records.some((s) => s && s.to === version && s.at >= since && s.cwd === here);
}
