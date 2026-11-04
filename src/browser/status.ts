/** The `browser status` report: what could be determined, and "unavailable" for what could not. */

import type { Probe } from "./probe.js";

export interface StatusInputs {
  probe: Probe | null;
  profile: string;
  /** Whether Chrome ever initialised the profile; a sign-in is not provable from the disk. */
  profileUsed: boolean;
  /** Null when the bridge did not answer. */
  pageCount: number | null;
  /** Set only when the service this tool installed exists, so it is the one the command restarts. */
  restartCommand: string | null;
}

export interface Status {
  running: boolean;
  mode: string;
  profile: { path: string; initialised: boolean };
  server: { pid: number; ageSec: number; rssMb: number; treeRssMb: number } | null;
  pages: number | "unavailable";
  budget: { maxMb: number; over: boolean } | null;
  restartCommand: string | null;
}

export function buildStatus(i: StatusInputs): Status {
  const { probe } = i;
  return {
    running: probe !== null,
    mode: probe?.mode ?? "not running",
    profile: { path: i.profile, initialised: i.profileUsed },
    server: probe && { pid: probe.pid, ageSec: probe.ageSec, rssMb: probe.serverRssMb, treeRssMb: probe.treeRssMb },
    pages: i.pageCount ?? "unavailable",
    budget: probe && { maxMb: probe.budget.maxMb, over: probe.budget.over },
    // Only worth naming when there is something to act on.
    restartCommand: probe?.budget.over ? i.restartCommand : null,
  };
}

const age = (sec: number) => (sec >= 86400 ? `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`);

export function formatStatus(s: Status): string[] {
  const lines = [
    `server: ${s.running ? `running (pid ${s.server!.pid}, up ${age(s.server!.ageSec)})` : "not running"}`,
    `mode: ${s.mode}`,
    `profile: ${s.profile.path} (${s.profile.initialised ? "has been used by Chrome" : "no Chrome profile yet — run: project-brain browser login"})`,
  ];
  if (s.server) {
    lines.push(`memory: server ${s.server.rssMb} MB, with its browser ${s.server.treeRssMb} MB`);
    lines.push(`budget: ${s.budget!.maxMb} MB — ${s.budget!.over ? "OVER BUDGET" : "within budget"}`);
  }
  lines.push(`open pages: ${s.pages}`);
  if (s.restartCommand) lines.push(`restart when no session is mid-task: ${s.restartCommand}`);
  return lines;
}
