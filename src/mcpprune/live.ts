import { readdir, readFile, readlink } from "node:fs/promises";
import { isClaudeProcess } from "../sessions/model.js";

/** Working directories of running Claude Code sessions. Rejects when they cannot be determined. */
export type ClaudeCwdLister = () => Promise<string[]>;

export const LIST_TIMEOUT_MS = 2_000;

async function run(cmd: string[], timeoutMs: number): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (proc.signalCode) throw new Error(`${cmd[0]} timed out`);
    // lsof exits 1 when some pid has no cwd it may read; its output is still valid.
    if (code !== 0 && !(cmd[0] === "lsof" && out.length > 0)) throw new Error(`${cmd[0]} exited ${code}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** `pid rest-of-line` rows of a `ps -o pid=,<one column>=` listing; the column may hold spaces. */
export function parsePidColumn(output: string): Map<string, string> {
  return new Map(
    output.split("\n").flatMap((line) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      return m ? [[m[1]!, m[2]!.trim()] as [string, string]] : [];
    })
  );
}

/** Pids of Claude Code processes from `ps -o pid=,comm=` (the full executable path on macOS) and `ps -o pid=,args=`. */
export function claudePids(comm: string, args: string): string[] {
  const argsOf = parsePidColumn(args);
  return [...parsePidColumn(comm)].flatMap(([pid, exe]) => (isClaudeProcess(exe, argsOf.get(pid) ?? "") ? [pid] : []));
}

async function darwinCwds(timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const [comm, args] = await Promise.all([run(["ps", "-axo", "pid=,comm="], timeoutMs), run(["ps", "-axo", "pid=,args="], timeoutMs)]);
  const pids = claudePids(comm, args);
  if (pids.length === 0) return [];
  const out = await run(["lsof", "-a", "-d", "cwd", "-p", pids.join(","), "-Fn"], Math.max(1, deadline - Date.now()));
  return out.split("\n").flatMap((l) => (l.startsWith("n/") ? [l.slice(1)] : []));
}

async function linuxCwds(): Promise<string[]> {
  const cwds: string[] = [];
  for (const pid of (await readdir("/proc")).filter((n) => /^\d+$/.test(n))) {
    const exe = await readlink(`/proc/${pid}/exe`).catch(() => "");
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf-8").catch(() => "");
    if (!isClaudeProcess(exe, cmdline.replaceAll("\u0000", " "))) continue;
    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
    if (cwd) cwds.push(cwd);
  }
  return cwds;
}

/** The default lister: `ps` + `lsof` on macOS, `/proc` on Linux; rejects elsewhere or after {@link LIST_TIMEOUT_MS}. */
export const listClaudeCwds: ClaudeCwdLister = async () => {
  const work = process.platform === "darwin" ? darwinCwds(LIST_TIMEOUT_MS) : process.platform === "linux" ? linuxCwds() : null;
  if (!work) throw new Error(`no process detection on ${process.platform}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("process detection timed out")), LIST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};
