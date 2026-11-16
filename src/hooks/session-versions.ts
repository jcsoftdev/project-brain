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
 * One small file per session under `<dataDir>/sessions/`, written atomically, one per swap under
 * `<dataDir>/swaps/`, and one per live server under `<dataDir>/servers/`. Nothing is shared, so
 * concurrent writers cannot undo each other and the prompt hook reads a single tiny file.
 */
import { join } from "node:path";
import { rmSync } from "node:fs";
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


/**
 * A running MCP server, written by `serve` at startup and removed on exit, so `project-brain status`
 * can name the version each live server runs. Servers from before this record existed are found
 * through the process table instead (see {@link staleServers}).
 */
export interface ServerRecord {
  pid: number;
  version: string;
  cwd: string;
  startedAt: number;
}

/** One process, joined from `ps -Ao pid=,ppid=,uid=,etime=,comm=` and `ps -Ao pid=,args=`. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  uid: number;
  startedAt: number;
  /** The executable: a full path on macOS, a name of at most 15 characters on Linux. */
  comm: string;
  args: string;
}

export interface StaleServer {
  pid: number;
  /** Null for a server too old to have recorded itself: older than the installed binary, version unknown. */
  version: string | null;
  cwd: string | null;
  startedAt: number;
}

const serversDir = (dataDir: string) => join(dataDir, "servers");
const serverFile = (dataDir: string, pid: number) => join(serversDir(dataDir), `${pid}.json`);
const pidOf = (name: string) => (/^\d+\.json$/.test(name) ? Number(name.slice(0, -".json".length)) : null);
/** A leftover of an interrupted atomic write is removed once it is this old. */
const TMP_MAX_AGE_MS = 5 * 60_000;
/** ps reports whole seconds, so a recorded process may appear to start up to a second after its record. */
const START_SKEW_MS = 2000;
/** A record written later than this after its process started belongs to some other process. */
const MAX_STARTUP_MS = 60_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another user's process still exists; only "no such process" means gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Drops records `keep` rejects, and temp files an interrupted write left behind. */
async function prune(dir: string, keep: (pid: number) => boolean, now: number): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (n) => {
      const pid = pidOf(n);
      const drop =
        pid !== null ? !keep(pid) : n.endsWith(".tmp") && (await stat(join(dir, n)).then((s) => now - s.mtimeMs > TMP_MAX_AGE_MS, () => false));
      if (drop) await rm(join(dir, n), { force: true }).catch(() => {});
    })
  );
}

/** Records this server, and drops the records of servers killed before they could remove their own. */
export async function recordServer(dataDir: string, record: ServerRecord): Promise<void> {
  const dir = serversDir(dataDir);
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(serverFile(dataDir, record.pid), `${JSON.stringify({ ...record, cwd: await realOrSame(record.cwd) })}\n`);
  await prune(dir, (pid) => pid === record.pid || alive(pid), record.startedAt);
}

/** Synchronous, for an exit handler. */
export function forgetServer(dataDir: string, pid: number): void {
  try {
    rmSync(serverFile(dataDir, pid), { force: true });
  } catch {
    /* the next server's startup prunes it */
  }
}

export async function readServers(dataDir: string): Promise<ServerRecord[]> {
  const dir = serversDir(dataDir);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => pidOf(n) !== null);
  const records = await Promise.all(names.map((n) => readJson<ServerRecord | null>(join(dir, n), null)));
  return records.filter((r): r is ServerRecord => !!r && typeof r.pid === "number" && typeof r.version === "string" && typeof r.startedAt === "number");
}

/**
 * The records whose process is still the one that wrote them: a project-brain server, under that pid,
 * started when the record says. Anything else (a pid recycled after a crash or a reboot) is removed.
 */
export async function liveServers(dataDir: string, rows: ProcessRow[], now: number = Date.now()): Promise<ServerRecord[]> {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const owns = (record: ServerRecord) => {
    const row = byPid.get(record.pid);
    if (!row || !isServeCommand(row, true)) return false;
    const lag = record.startedAt - row.startedAt;
    return lag >= -START_SKEW_MS && lag <= MAX_STARTUP_MS;
  };
  const live = (await readServers(dataDir)).filter(owns);
  const kept = new Set(live.map((r) => r.pid));
  await prune(serversDir(dataDir), (pid) => kept.has(pid), now);
  return live;
}

/** `[[dd-]hh:]mm:ss` to seconds. */
function elapsedSeconds(etime: string): number {
  const [days, clock] = etime.includes("-") ? etime.split("-", 2) : ["0", etime];
  const [s = 0, m = 0, h = 0] = clock!.split(":").map(Number).reverse();
  return Number(days) * 86_400 + h * 3600 + m * 60 + s;
}

/** Joins the two ps reads by pid; `comm` and `args` are last in their read, so spaces in them survive. */
export function parseProcessTable(meta: string, args: string, now: number): ProcessRow[] {
  const argsByPid = new Map<number, string>();
  for (const line of args.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) argsByPid.set(Number(m[1]), m[2]!.trim());
  }
  const rows: ProcessRow[] = [];
  for (const line of meta.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:-]+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const seconds = elapsedSeconds(m[4]!);
    if (!Number.isFinite(seconds)) continue;
    rows.push({ pid, ppid: Number(m[2]), uid: Number(m[3]), startedAt: now - seconds * 1000, comm: m[5]!.trim(), args: argsByPid.get(pid) ?? m[5]!.trim() });
  }
  return rows;
}

const basename = (path: string) => path.split(/[/\\]/).pop() ?? path;
/** The release binary, or the npm platform package's `project-brain-native` that the shim runs. */
const BINARY = /^project-brain(-native)?(\.exe)?$/;
const INTERPRETER = /^(bun|node)(\.exe)?$/;
/** What follows the program on a server's command line: nothing, or `serve` and its flags. */
const SERVE_TAIL = /^\s*(serve(\s.*)?)?$/;

/**
 * Whether a process is a project-brain MCP server, judged by its executable: the `project-brain`
 * binary, or bun/node running the npm shim (a script named `project-brain`), started with no command
 * or with `serve`. `withSource` also accepts bun running a checkout's `src/cli.ts`, which only a
 * record can vouch for: another project's `src/cli.ts` looks the same.
 */
export function isServeCommand(row: Pick<ProcessRow, "comm" | "args">, withSource = false): boolean {
  const exe = basename(row.comm);
  if (BINARY.test(exe)) {
    const at = /project-brain(-native)?(\.exe)?(?=\s|$)/.exec(row.args);
    return at !== null && SERVE_TAIL.test(row.args.slice(at.index + at[0].length));
  }
  if (!INTERPRETER.test(exe)) return false;
  const afterInterpreter = row.args.startsWith(row.comm) ? row.args.slice(row.comm.length) : row.args.replace(/^\S+/, "");
  const script = withSource ? /^\s*(?:.*?[/\\])?(project-brain|src[/\\]cli\.[jt]s)(?=\s|$)/ : /^\s*(?:.*?[/\\])?project-brain(?=\s|$)/;
  const m = script.exec(afterInterpreter);
  return m !== null && SERVE_TAIL.test(afterInterpreter.slice(m[0].length));
}

export interface StaleOptions {
  /** Only this user's processes count; another user's servers are not this user's to reconnect. */
  uid?: number;
  /**
   * When the installed binary was put in place (its ctime). A server with no record that started
   * after it runs the installed code from another HOME, so only earlier ones are reported. Null when
   * unknown: then servers without a record are not reported at all.
   */
  installedAt: number | null;
}

/**
 * Live MCP servers older than `installed`. A recorded server (validated by {@link liveServers}) is
 * judged by its version. A server in the process table without a record predates recording, so it
 * is older. A process whose child is a server is the hot-swap supervisor relaying to it: the child is
 * judged.
 */
export function staleServers(rows: ProcessRow[], records: ServerRecord[], installed: string, opts: StaleOptions): StaleServer[] {
  const recorded = new Map(records.map((r) => [r.pid, r]));
  const mine = rows.filter((r) => opts.uid === undefined || r.uid === opts.uid);
  const unrecorded = mine.filter((r) => !recorded.has(r.pid) && isServeCommand(r));
  const serverPids = new Set([...recorded.keys(), ...unrecorded.map((r) => r.pid)]);
  const supervisors = new Set(rows.filter((r) => serverPids.has(r.pid)).map((r) => r.ppid));

  const stale: StaleServer[] = records
    .filter((r) => isNewer(installed, r.version))
    .map((r) => ({ pid: r.pid, version: r.version, cwd: r.cwd, startedAt: r.startedAt }));
  if (opts.installedAt !== null)
    for (const row of unrecorded)
      if (!supervisors.has(row.pid) && row.startedAt < opts.installedAt) stale.push({ pid: row.pid, version: null, cwd: null, startedAt: row.startedAt });
  return stale.sort((a, b) => a.startedAt - b.startedAt);
}
