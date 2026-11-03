import {
  describeActivity,
  formatAge,
  idleMs,
  isSessionCommand,
  lineage,
  liveChildCount,
  parseDuration,
  selectPrune,
} from "../sessions/model.js";
import type { Session } from "../sessions/model.js";
import { systemHost, type SessionHost } from "../sessions/host.js";

const DEFAULT_IDLE = "24h";

const USAGE = `Usage: project-brain sessions [--json]
       project-brain sessions --prune [--idle <90m|12h|2d>] [--yes] [--force-children] [--include-unknown]`;

export function discoverSessions(host: SessionHost): { sessions: Session[]; protectedPids: Set<number> } {
  const table = host.processTable();
  const sessions = table
    .filter((row) => row.pid !== process.pid && isSessionCommand(row.command))
    .map((row): Session => {
      const cwd = host.cwd(row.pid);
      return {
        pid: row.pid,
        ageSec: row.etimeSec,
        memoryMb: host.memoryMb(row.pid),
        cwd,
        lastActivityMs: cwd === null ? null : host.lastActivityMs(cwd),
        liveChildren: liveChildCount(row, table),
      };
    })
    .sort((a, b) => (b.memoryMb ?? 0) - (a.memoryMb ?? 0));
  return { sessions, protectedPids: lineage(process.pid, table) };
}

const pad = (text: string, width: number) => text.padEnd(width);

function printTable(sessions: readonly Session[], now: number): void {
  const rows = sessions.map((s) => [
    String(s.pid),
    formatAge(s.ageSec),
    s.memoryMb === null ? "?" : `${s.memoryMb} MB`,
    String(s.liveChildren),
    describeActivity(idleMs(s, now)),
    s.cwd ?? "?",
  ]);
  const header = ["PID", "AGE", "MEM", "KIDS", "STATE", "CWD"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  for (const row of [header, ...rows]) console.log(row.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd());
  const total = sessions.reduce((sum, s) => sum + (s.memoryMb ?? 0), 0);
  console.log(`\n${sessions.length} session(s), ${total} MB total`);
}

function optionValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

export async function execute(args: string[], host: SessionHost = systemHost, now = Date.now()): Promise<number> {
  const idleText = optionValue(args, "--idle") ?? DEFAULT_IDLE;
  const idle = parseDuration(idleText);
  if (idle === null) {
    console.error(`Invalid --idle "${idleText}" (expected e.g. 90m, 12h, 2d).\n${USAGE}`);
    return 1;
  }

  const { sessions, protectedPids } = discoverSessions(host);

  if (!args.includes("--prune")) {
    if (args.includes("--json")) {
      console.log(JSON.stringify(sessions.map((s) => ({ ...s, idleMs: idleMs(s, now), protected: protectedPids.has(s.pid) })), null, 2));
    } else {
      printTable(sessions, now);
    }
    return 0;
  }

  const apply = args.includes("--yes");
  const verdicts = selectPrune(sessions, {
    now,
    idleMs: idle,
    protectedPids,
    forceChildren: args.includes("--force-children"),
    includeUnknown: args.includes("--include-unknown"),
  });

  let closed = 0;
  for (const verdict of verdicts) {
    const session = sessions.find((s) => s.pid === verdict.pid)!;
    const label = `pid ${session.pid} (${session.memoryMb ?? "?"} MB, ${session.cwd ?? "?"})`;
    if (!verdict.close) {
      console.log(`Keeping ${label} — ${verdict.reason}`);
      continue;
    }
    if (!apply) {
      console.log(`Would close ${label}`);
      continue;
    }
    host.terminate(session.pid);
    closed++;
    console.log(`Closed ${label} — recover it with \`claude --resume\``);
  }
  if (!apply) console.log("\nDry run. Re-run with --yes to send SIGTERM to the sessions above.");
  else console.log(`\n${closed} session(s) sent SIGTERM.`);
  return 0;
}
