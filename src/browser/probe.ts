/** Reads the shared server's state from the live process table. Read-only: it signals nothing. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT } from "../setup/chrome-shared-server.js";
import { profileDir } from "../setup/chrome-profile.js";
import { assess, maxMb, type Budget } from "./budget.js";
import { findSharedServer, parsePs, serverMode, type ServerMode } from "./server-stats.js";

export interface Probe {
  port: number;
  pid: number;
  mode: ServerMode;
  ageSec: number;
  /** The server process alone, which is what the budget is measured against. */
  serverRssMb: number;
  /** The server plus the browser it launched. */
  treeRssMb: number;
  budget: Budget;
}

export function sharedPort(dataDir: string): number {
  try {
    const port = JSON.parse(readFileSync(join(dataDir, "chrome-shared-server.json"), "utf8")).port;
    return typeof port === "number" ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/** Null when no shared server is running or the process table cannot be read. */
export function probeSharedServer(dataDir: string, env: Record<string, string | undefined> = process.env): Probe | null {
  try {
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss=,etime=,command="], { stdout: "pipe", stderr: "ignore" });
    const port = sharedPort(dataDir);
    const found = findSharedServer(parsePs(ps.stdout.toString()), port);
    if (!found) return null;

    return {
      port,
      pid: found.server.pid,
      mode: serverMode(found.server.command, profileDir(dataDir)),
      ageSec: found.server.ageSec,
      serverRssMb: Math.round(found.server.rssKb / 1024),
      treeRssMb: Math.round(found.treeRssKb / 1024),
      budget: assess(found.server.rssKb, maxMb(env)),
    };
  } catch {
    return null;
  }
}
