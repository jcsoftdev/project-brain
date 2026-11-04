/**
 * What can be known about the running shared chrome-devtools server from the process table alone.
 *
 * Read-only on purpose: `ps` output is parsed, nothing is signalled. The mode is read from the
 * RUNNING command line rather than from a config file, because that is the one thing that cannot
 * disagree with what the server actually does.
 */

import { entryAutoConnectState } from "../setup/chrome-autoconnect.js";
import { servedChromeArgs } from "../setup/chrome-shared-server.js";

export interface Proc {
  pid: number;
  ppid: number;
  rssKb: number;
  ageSec: number;
  command: string;
}

/** `ps` elapsed time: `[[dd-]hh:]mm:ss`. */
export function parseEtime(etime: string): number {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = clock!.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  return Number(days) * 86400 + h * 3600 + m * 60 + s;
}

/** Output of `ps -axo pid=,ppid=,rss=,etime=,command=`. */
export function parsePs(text: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) procs.push({ pid: +m[1]!, ppid: +m[2]!, rssKb: +m[3]!, ageSec: parseEtime(m[4]!), command: m[5]! });
  }
  return procs;
}

export interface SharedServer {
  proxy: Proc;
  server: Proc;
  /** Resident memory of the server and everything it launched, in kB. */
  treeRssKb: number;
}

function descendants(procs: Proc[], root: Proc): Proc[] {
  const found: Proc[] = [];
  const queue = [root];
  while (queue.length) {
    const at = queue.shift()!;
    for (const p of procs) {
      if (p.ppid === at.pid && !found.includes(p)) {
        found.push(p);
        queue.push(p);
      }
    }
  }
  return found;
}

/** The chrome-devtools-mcp process running behind the bridge listening on `port`, or null. */
export function findSharedServer(procs: Proc[], port: number): SharedServer | null {
  const proxy = procs.find((p) => p.command.includes("mcp-proxy") && p.command.includes(`--port ${port}`));
  if (!proxy) return null;

  const below = descendants(procs, proxy);
  const server = below.find((p) => p.command.toLowerCase().includes("chrome-devtools-mcp"));
  if (!server) return null;

  const tree = [server, ...descendants(procs, server)];
  return { proxy, server, treeRssKb: tree.reduce((sum, p) => sum + p.rssKb, 0) };
}

export type ServerMode = "headless-profile" | "autoConnect" | "foreign";

/**
 * `headless-profile` is the default this tool installs; `autoConnect` attaches to the owner's
 * Chrome; anything else is somebody's own arrangement and is only reported, never acted on.
 */
export function serverMode(command: string, profile: string): ServerMode {
  const args = servedChromeArgs(command.split(/\s+/)) ?? [];
  if (entryAutoConnectState({ args }) === "present") return "autoConnect";
  const ownProfile = args.some((a) => a === `--userDataDir=${profile}` || a === `--user-data-dir=${profile}`);
  const headless = args.some((a) => /^--headless(=true)?$/.test(a));
  return ownProfile && headless ? "headless-profile" : "foreign";
}
