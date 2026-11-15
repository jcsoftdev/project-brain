import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../constants.js";
import { buildLedger, projectOf, type Ledger, type ProjectStats, type SessionStats } from "../ledger/scan.js";

export const STATS_USAGE = `Usage: project-brain stats [--days N] [--all] [--json]

What project-brain put into your Claude Code sessions, read from local transcripts only:
  injected      the prompt-context hook's blocks (prompts, hits, tokens)
  used          injected hits whose file the model later read, edited, named in a shell command,
                or got back from a project-brain tool in the same transcript
  gate dropped  context the Jev context gate left out (~/.project-brain/context-gate-log.json)
  MCP           tool names and server instructions the session's MCP set added to context
  pruned        MCP servers mcp-prune disabled for the session's directory before it began

Token figures are estimates (characters / 4). Nothing is sent anywhere and nothing is written.
  --days N   window in days (default 7)
  --all      every project, not only the current one
  --json     machine-readable; holds counts, sources and scores, never prompt text`;

/** The hand-labelled measurement behind the global floor (scripts/calibrate-hook-floor.ts, 30 prompts). */
const FLOOR_BASIS = "hand-labelled: precision 0.62, recall 0.64 on 30 prompts";

export interface StatsDeps {
  projectsRoot?: string;
  dataDir?: string;
  cwd?: string;
  now?: number;
  log?: (line: string) => void;
}

export interface HookFloor {
  floor: number;
  source: "env" | "default";
  basis: string;
}

export async function hookFloor(env: NodeJS.ProcessEnv = process.env): Promise<HookFloor> {
  const { HOOK_MIN_SCORE } = await import("./search.js");
  const n = Number(env.PROJECT_BRAIN_SEARCH_MIN_SCORE);
  if (env.PROJECT_BRAIN_SEARCH_MIN_SCORE && n >= 0 && n <= 1) return { floor: n, source: "env", basis: "PROJECT_BRAIN_SEARCH_MIN_SCORE" };
  return { floor: HOOK_MIN_SCORE, source: "default", basis: FLOOR_BASIS };
}

const tok = (n: number): string => (n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`);
const day = (ms: number | undefined): string => (ms === undefined ? "????-??-?? ??:??" : new Date(ms).toISOString().slice(0, 16).replace("T", " "));
const pct = (n: number | null): string => (n === null ? "  -  " : n.toFixed(2));
const home = homedir();
const short = (path: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

function sessionLine(s: SessionStats): string {
  const parts = [
    s.injected.prompts === 0
      ? "injected nothing"
      : `injected ${s.injected.prompts} prompts / ${s.injected.hits} hits ${tok(s.injected.tokens)} tok, used ${s.usage.used}/${s.usage.hits}`,
    `gate dropped ${s.gateDropped.count} ${tok(s.gateDropped.tokens)} tok`,
    `MCP ${s.mcp.servers} servers ${tok(s.mcp.tokens)} tok${s.mcp.agentTokens > 0 ? ` (+${tok(s.mcp.agentTokens)} in agents)` : ""}`,
  ];
  if (s.pruned.length > 0) parts.push(`pruned: ${s.pruned.map((p) => (p.tokens === null ? p.name : `${p.name} (${tok(p.tokens)})`)).join(", ")}`);
  const agents = s.transcripts > 1 ? ` (+${s.transcripts - 1} agents)` : "";
  return `  ${day(s.lastAt)}  ${s.sessionId.slice(0, 8)}${agents}  ${parts.join(" · ")}`;
}

function projectLines(p: ProjectStats): string[] {
  const { signal } = p;
  const kinds = Object.entries(signal.byKind).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(", ");
  const lines = [
    `  ${short(p.project)}  ${p.sessions} sessions · injected ${tok(p.injectedTokens)} tok · gate dropped ${tok(p.gateDroppedTokens)} tok · MCP ${tok(p.mcpTokens)} tok`,
    ...(p.pruned.length > 0 ? [`    pruned MCP servers: ${p.pruned.join(", ")}`] : []),
  ];
  if (signal.hits > 0) {
    lines.push(`    usage signal (report only): ${signal.hits} distinct injected hits, ${signal.used} used${kinds ? ` (${kinds})` : ""}`);
    lines.push("      floor  hits  used  precision  recall");
    for (const r of signal.floors) {
      lines.push(`      ${r.floor.toFixed(2)}  ${String(r.hits).padStart(4)}  ${String(r.used).padStart(4)}  ${pct(r.precision).padStart(9)}  ${pct(r.recall).padStart(6)}`);
    }
  }
  return lines;
}

const SESSIONS_SHOWN = 10;

function render(ledger: Ledger, scope: string, floor: HookFloor): string[] {
  const { files, bytes, truncated } = ledger.scanned;
  const lines = [
    `project-brain stats: last ${ledger.days} days, ${scope} (${ledger.sessions.length} sessions; ${files} transcripts, ${(bytes / 1024 ** 2).toFixed(0)} MB read${truncated ? ", stopped at the byte budget" : ""})`,
    `Token figures are estimates (${ledger.estimator}).`,
  ];
  if (ledger.sessions.length === 0) return [...lines, "No sessions in this window."];
  lines.push("", `Sessions, newest first${ledger.sessions.length > SESSIONS_SHOWN ? ` (${SESSIONS_SHOWN} of ${ledger.sessions.length}; --json lists all)` : ""}:`);
  lines.push(...ledger.sessions.slice(0, SESSIONS_SHOWN).map(sessionLine));
  lines.push("", "Per project:");
  for (const p of ledger.projects) lines.push(...projectLines(p));
  lines.push(
    "",
    `Hook floor for every project: ${floor.floor.toFixed(2)} (${floor.source === "env" ? "set by" : "global default,"} ${floor.basis}); not adjusted automatically.`,
    "Used means the model touched the hit's file later in the same transcript, for any reason. Only hits at or",
    "above the floor in force were injected, so the table cannot show what a lower floor would add."
  );
  return lines;
}

function parseDays(args: string[]): number | null {
  const i = args.indexOf("--days");
  if (i < 0) return 7;
  const n = Number(args[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** `project-brain stats`: read-only report over local transcripts, the context-gate log and the MCP prune state. */
export async function execute(args: string[], deps: StatsDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  if (args.includes("--help") || args.includes("-h")) return log(STATS_USAGE);
  const days = parseDays(args);
  if (days === null) {
    console.error("--days needs a positive whole number");
    process.exitCode = 1;
    return;
  }

  let projectRoot: string | null = null;
  if (!args.includes("--all")) {
    const cwd = deps.cwd ?? process.cwd();
    const { findProjectRoot } = await import("./resolve-project.js");
    projectRoot = projectOf(findProjectRoot(cwd) ?? cwd);
  }

  const ledger = await buildLedger({
    projectsRoot: deps.projectsRoot ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"),
    dataDir: deps.dataDir ?? DATA_DIR,
    days,
    projectRoot,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const floor = await hookFloor();

  if (args.includes("--json")) {
    log(JSON.stringify({ ...ledger, scope: projectRoot ?? "all", hookFloor: floor }, null, 2));
    return;
  }
  for (const line of render(ledger, projectRoot === null ? "all projects" : short(projectRoot), floor)) log(line);
}
