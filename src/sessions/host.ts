import { spawnSync } from "node:child_process";
import { readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseProcessTable, transcriptDirName, type ProcRow } from "./model.js";

/** Everything that touches the machine; the selection logic never imports this. */
export interface SessionHost {
  processTable(): ProcRow[];
  memoryMb(pid: number): number | null;
  cwd(pid: number): string | null;
  lastActivityMs(cwd: string): number | null;
  terminate(pid: number): void;
}

const run = (cmd: string, args: string[]): string => {
  const result = spawnSync(cmd, args, { encoding: "utf-8" });
  return result.status === 0 ? result.stdout : "";
};

function rssMb(pid: number): number | null {
  const kb = Number(run("ps", ["-o", "rss=", "-p", String(pid)]).trim());
  return kb > 0 ? Math.round(kb / 1024) : null;
}

/** `footprint` is the figure Activity Monitor shows; RSS undercounts compressed memory on macOS. */
function footprintMb(pid: number): number | null {
  const match = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(run("footprint", [String(pid)]));
  if (!match) return rssMb(pid);
  const scale = { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2] as "KB" | "MB" | "GB"];
  return Math.round(Number(match[1]) * scale);
}

function cwdOf(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  return /^n(.+)$/m.exec(run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]))?.[1] ?? null;
}

export function lastTranscriptWrite(projectsDir: string, cwd: string): number | null {
  const dir = join(projectsDir, transcriptDirName(cwd));
  try {
    const times = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => statSync(join(dir, name)).mtimeMs);
    return times.length > 0 ? Math.max(...times) : null;
  } catch {
    return null;
  }
}

export const systemHost: SessionHost = {
  processTable: () => parseProcessTable(run("ps", ["-axo", "pid,ppid,etime,command"])),
  memoryMb: (pid) => (process.platform === "darwin" ? footprintMb(pid) : rssMb(pid)),
  cwd: cwdOf,
  lastActivityMs: (cwd) => lastTranscriptWrite(join(homedir(), ".claude", "projects"), cwd),
  terminate: (pid) => process.kill(pid, "SIGTERM"),
};
