import { basename } from "node:path";

const HOUR = 3_600_000;
const DURATION_UNITS: Record<string, number> = { m: 60_000, h: HOUR, d: 24 * HOUR };

/** A Claude Code process is a session only when it is the interactive CLI, not one of its own helpers. */
const HELPER_ARGS = new Set(["bg-pty-host", "bg-spare", "daemon", "mcp"]);

/** Children born this close to their session are the MCP servers it starts with, not work it is doing. */
const STARTUP_WINDOW_SEC = 120;

/** Children Claude Code spawns for itself that say nothing about user work. */
const BACKGROUND_COMMANDS = new Set(["caffeinate"]);

export interface ProcRow {
  pid: number;
  ppid: number;
  etimeSec: number;
  command: string;
}

export interface Session {
  pid: number;
  ageSec: number;
  memoryMb: number | null;
  cwd: string | null;
  /** Epoch ms of the newest transcript write; null when none could be found. */
  lastActivityMs: number | null;
  /** Children that are doing work, MCP servers started with the session excluded. */
  liveChildren: number;
}

export interface PruneOptions {
  now: number;
  idleMs: number;
  /** Pids of this process and every ancestor of it. */
  protectedPids: ReadonlySet<number>;
  forceChildren: boolean;
  includeUnknown: boolean;
}

export type Verdict = { pid: number; close: true } | { pid: number; close: false; reason: string };

export function parseDuration(text: string): number | null {
  const match = /^(\d+)([mhd])$/.exec(text.trim());
  if (!match) return null;
  const ms = Number(match[1]) * DURATION_UNITS[match[2]];
  return ms > 0 ? ms : null;
}

/** `ps` etime: `[[dd-]hh:]mm:ss`. */
export function parseEtime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  const [days, hours, minutes, seconds] = [match[1], match[2], match[3], match[4]].map((n) => Number(n ?? 0));
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/** How Claude Code names a working directory's transcript folder under `~/.claude/projects`. */
export function transcriptDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function parseProcessTable(output: string): ProcRow[] {
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    const etimeSec = match ? parseEtime(match[3]) : null;
    return match && etimeSec !== null
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), etimeSec, command: match[4].trim() }]
      : [];
  });
}

export function isSessionCommand(command: string): boolean {
  const [exe = "", firstArg = ""] = command.trim().split(/\s+/);
  const isClaude = basename(exe) === "claude" || exe.includes("/claude/versions/");
  return isClaude && !HELPER_ARGS.has(firstArg) && !command.includes("--chrome-native-host");
}

export function liveChildCount(session: ProcRow, table: readonly ProcRow[]): number {
  return table.filter(
    (row) =>
      row.ppid === session.pid &&
      row.etimeSec < session.etimeSec - STARTUP_WINDOW_SEC &&
      !BACKGROUND_COMMANDS.has(basename(row.command.split(/\s+/)[0] ?? ""))
  ).length;
}

/** The pid itself plus every ancestor, so a session hosting this command is never a candidate. */
export function lineage(pid: number, table: readonly ProcRow[]): Set<number> {
  const parentOf = new Map(table.map((row) => [row.pid, row.ppid]));
  const chain = new Set<number>();
  for (let at: number | undefined = pid; at && !chain.has(at); at = parentOf.get(at)) chain.add(at);
  return chain;
}

export function idleMs(session: Session, now: number): number | null {
  return session.lastActivityMs === null ? null : Math.max(0, now - session.lastActivityMs);
}

export function judge(session: Session, opts: PruneOptions): Verdict {
  const idle = idleMs(session, opts.now);
  const refuse = (reason: string): Verdict => ({ pid: session.pid, close: false, reason });

  if (opts.protectedPids.has(session.pid)) return refuse("hosts this command");
  if (session.liveChildren > 0 && !opts.forceChildren) return refuse(`${session.liveChildren} live child process(es)`);
  if (idle === null) return opts.includeUnknown ? { pid: session.pid, close: true } : refuse("last activity unknown");
  return idle > opts.idleMs ? { pid: session.pid, close: true } : refuse("active within the idle window");
}

/**
 * Only pids discovered as sessions are ever judged, so a pid that is not one can never be closed:
 * `sessions` is the single input to the closing list.
 */
export function selectPrune(sessions: readonly Session[], opts: PruneOptions): Verdict[] {
  return sessions.map((session) => judge(session, opts));
}

export function formatAge(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

export function describeActivity(idle: number | null): string {
  if (idle === null) return "unknown";
  return idle < HOUR ? "active" : `idle ${formatAge(Math.floor(idle / 1000))}`;
}
