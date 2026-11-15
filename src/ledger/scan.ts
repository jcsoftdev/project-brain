import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectDirKey } from "../toolcatalog/transcripts.js";
import { usageSignal, type UsageSignal } from "./signal.js";
import { parseTranscript, type HitUsage, type TranscriptLedger } from "./transcript.js";

/** Every token figure here is an estimate: characters / 4, the same rule as retrieval/budget.ts. */
export const TOKEN_ESTIMATOR = "chars/4";
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

export const LEDGER_MAX_BYTES = 2 * 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface LedgerOptions {
  /** ~/.claude/projects */
  projectsRoot: string;
  /** ~/.project-brain: the context-gate log and the MCP prune state live here. */
  dataDir: string;
  days: number;
  /** Only sessions started in this directory or below it; null for every project. */
  projectRoot: string | null;
  now?: number;
  maxBytes?: number;
}

export interface SessionStats {
  sessionId: string;
  project: string;
  firstAt?: number;
  lastAt?: number;
  /** The session's own transcript plus one per subagent. */
  transcripts: number;
  injected: { prompts: number; hits: number; chars: number; tokens: number };
  usage: { hits: number; used: number };
  gateDropped: { count: number; chars: number; tokens: number; byEvent: Record<string, number> };
  /** The session's own context; each subagent loads its own set, summed in `agentTokens`. */
  mcp: { servers: number; tools: number; chars: number; tokens: number; agentTokens: number; byServer: Record<string, { tools: number; tokens: number }> };
  /**
   * Disabled by mcp-prune for the session's exact directory (Claude Code keys MCP settings by it) before
   * the session began; tokens as the largest cost that server had in another scanned session, null if unseen.
   */
  pruned: Array<{ name: string; tokens: number | null }>;
  hits: HitUsage[];
}

export interface ProjectStats {
  project: string;
  sessions: number;
  injectedTokens: number;
  gateDroppedTokens: number;
  mcpTokens: number;
  pruned: string[];
  signal: UsageSignal;
}

export interface Ledger {
  generatedAt: number;
  days: number;
  estimator: string;
  scanned: { files: number; bytes: number; truncated: boolean };
  sessions: SessionStats[];
  projects: ProjectStats[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A worktree session belongs to the repository it was cut from. */
export const projectOf = (cwd: string): string => cwd.replace(/\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/, "");

const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

interface File {
  path: string;
  mtime: number;
  size: number;
}

async function jsonl(dir: string): Promise<File[]> {
  const out: File[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await jsonl(join(path, "subagents"))));
    } else if (entry.name.endsWith(".jsonl")) {
      const st = await stat(path).catch(() => null);
      if (st) out.push({ path, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

interface GateDrop {
  session: string;
  event: string;
  chars: number;
}

async function gateDrops(dataDir: string): Promise<GateDrop[]> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, "context-gate-log.json"), "utf-8")) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw.dropped)) return [];
    return raw.dropped.filter(isRecord).flatMap((d) =>
      typeof d.session === "string" ? [{ session: d.session, event: typeof d.event === "string" ? d.event : "?", chars: typeof d.chars === "number" ? d.chars : 0 }] : []
    );
  } catch {
    return [];
  }
}

interface PruneEntry {
  project: string;
  name: string;
  at: number;
}

async function pruned(dataDir: string): Promise<PruneEntry[]> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, "mcp-prune.json"), "utf-8")) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw.disabled)) return [];
    return raw.disabled.filter(isRecord).flatMap((e) =>
      typeof e.project === "string" && typeof e.name === "string" && e.pending !== true
        ? [{ project: e.project, name: e.name, at: typeof e.at === "string" ? Date.parse(e.at) || 0 : 0 }]
        : []
    );
  } catch {
    return [];
  }
}

/** Reads transcripts newest first within the window and the byte budget. Local files only. */
export async function buildLedger(opts: LedgerOptions): Promise<Ledger> {
  const now = opts.now ?? Date.now();
  const since = now - opts.days * DAY_MS;
  const maxBytes = opts.maxBytes ?? LEDGER_MAX_BYTES;
  const folderPrefix = opts.projectRoot === null ? null : projectDirKey(opts.projectRoot);

  const files: File[] = [];
  for (const dir of await readdir(opts.projectsRoot).catch(() => [])) {
    if (folderPrefix !== null && !dir.startsWith(folderPrefix)) continue;
    files.push(...(await jsonl(join(opts.projectsRoot, dir))));
  }
  const recent = files.filter((f) => f.mtime >= since).sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));

  const ledgers: TranscriptLedger[] = [];
  let bytes = 0;
  let read = 0;
  let truncated = false;
  for (const file of recent) {
    if (bytes + file.size > maxBytes) {
      truncated = true;
      break;
    }
    const text = await readFile(file.path).catch(() => null);
    if (text === null) continue;
    bytes += file.size;
    read++;
    const ledger = parseTranscript(text);
    if (!ledger.sessionId || !ledger.cwd || (ledger.lastAt ?? file.mtime) < since) continue;
    if (opts.projectRoot !== null && !within(projectOf(ledger.cwd), opts.projectRoot)) continue;
    ledgers.push(ledger);
  }

  const drops = await gateDrops(opts.dataDir);
  const disabled = await pruned(opts.dataDir);
  const serverCost = new Map<string, number>();
  for (const l of ledgers) for (const [name, c] of Object.entries(l.mcp)) serverCost.set(name, Math.max(serverCost.get(name) ?? 0, c.chars));

  const bySession = new Map<string, TranscriptLedger[]>();
  for (const l of ledgers) bySession.set(l.sessionId!, [...(bySession.get(l.sessionId!) ?? []), l]);

  const sessions = [...bySession.entries()].map(([sessionId, parts]): SessionStats => {
    const main = parts.find((p) => p.agentId === undefined) ?? parts[0]!;
    const project = projectOf(main.cwd!);
    const firstAt = Math.min(...parts.map((p) => p.firstAt ?? Infinity));
    const lastAt = Math.max(...parts.map((p) => p.lastAt ?? -Infinity));
    const injections = parts.flatMap((p) => p.injections);
    const hits = parts.flatMap((p) => p.hits);
    const injectedChars = injections.reduce((n, i) => n + i.chars, 0);
    const gate = drops.filter((d) => d.session === sessionId);
    const gateChars = gate.reduce((n, d) => n + d.chars, 0);
    const byEvent: Record<string, number> = {};
    for (const d of gate) byEvent[d.event] = (byEvent[d.event] ?? 0) + 1;
    const byServer = main.mcp;
    const mcpChars = Object.values(byServer).reduce((n, s) => n + s.chars, 0);
    const agentChars = parts.filter((p) => p !== main).reduce((n, p) => n + Object.values(p.mcp).reduce((m, s) => m + s.chars, 0), 0);
    const start = Number.isFinite(firstAt) ? firstAt : now;
    const prunedHere = [...new Set(disabled.filter((e) => e.project === main.cwd && e.at <= start).map((e) => e.name))].sort();
    return {
      sessionId,
      project,
      ...(Number.isFinite(firstAt) ? { firstAt } : {}),
      ...(Number.isFinite(lastAt) ? { lastAt } : {}),
      transcripts: parts.length,
      injected: { prompts: injections.length, hits: injections.reduce((n, i) => n + i.hits.length, 0), chars: injectedChars, tokens: estimateTokens(injectedChars) },
      usage: { hits: hits.length, used: hits.filter((h) => h.used.length > 0).length },
      gateDropped: { count: gate.length, chars: gateChars, tokens: estimateTokens(gateChars), byEvent },
      mcp: {
        servers: Object.keys(byServer).length,
        tools: Object.values(byServer).reduce((n, s) => n + s.tools, 0),
        chars: mcpChars,
        tokens: estimateTokens(mcpChars),
        agentTokens: estimateTokens(agentChars),
        byServer: Object.fromEntries(Object.entries(byServer).sort(([a], [b]) => a.localeCompare(b)).map(([n, s]) => [n, { tools: s.tools, tokens: estimateTokens(s.chars) }])),
      },
      pruned: prunedHere.map((name) => ({ name, tokens: serverCost.has(name) ? estimateTokens(serverCost.get(name)!) : null })),
      hits,
    };
  });
  sessions.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.sessionId.localeCompare(b.sessionId));

  const projects = [...new Set(sessions.map((s) => s.project))].sort().map((project): ProjectStats => {
    const own = sessions.filter((s) => s.project === project);
    const sum = (f: (s: SessionStats) => number) => own.reduce((n, s) => n + f(s), 0);
    return {
      project,
      sessions: own.length,
      injectedTokens: sum((s) => s.injected.tokens),
      gateDroppedTokens: sum((s) => s.gateDropped.tokens),
      mcpTokens: sum((s) => s.mcp.tokens + s.mcp.agentTokens),
      pruned: [...new Set(own.flatMap((s) => s.pruned.map((p) => p.name)))].sort(),
      signal: usageSignal(own.flatMap((s) => s.hits)),
    };
  });

  return { generatedAt: now, days: opts.days, estimator: TOKEN_ESTIMATOR, scanned: { files: read, bytes, truncated }, sessions, projects };
}
