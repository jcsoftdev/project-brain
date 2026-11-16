import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectDirKey } from "../toolcatalog/transcripts.js";
import { usageSignal, type UsageSignal } from "./signal.js";
import { mcpServerKey, parseTranscriptFile, type HitUsage, type McpServerCost, type TranscriptLedger } from "./transcript.js";

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
  /** Only sessions started in this directory or below it (or exactly in it, with `exact`); null for every project. */
  projectRoot: string | null;
  exact?: boolean;
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
  /**
   * The session's own context at its largest between compactions; each subagent loads its own set,
   * summed in `agentTokens`. Servers are keyed as Claude Code spells them in tool names.
   */
  mcp: {
    servers: number;
    tools: number;
    chars: number;
    tokens: number;
    agentTokens: number;
    compactions: number;
    byServer: Record<string, { tools: number; tokens: number }>;
  };
  /**
   * Disabled by mcp-prune for the session's exact directory (Claude Code keys MCP settings by it) before
   * the session began; tokens as the largest footprint that server had in any scanned session, null if unseen.
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

/** One session's transcripts: `<id>.jsonl` and `<id>/subagents/*.jsonl`, read or skipped together. */
interface SessionFiles {
  files: File[];
  mtime: number;
  size: number;
}

async function sessionFiles(dir: string): Promise<SessionFiles[]> {
  const groups = new Map<string, File[]>();
  const add = async (key: string, path: string) => {
    const st = await stat(path).catch(() => null);
    if (st?.isFile()) groups.set(key, [...(groups.get(key) ?? []), { path, mtime: st.mtimeMs, size: st.size }]);
  };
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) {
      const sub = join(dir, entry.name, "subagents");
      for (const name of await readdir(sub).catch(() => [])) if (name.endsWith(".jsonl")) await add(entry.name, join(sub, name));
    } else if (entry.name.endsWith(".jsonl")) {
      await add(entry.name.slice(0, -".jsonl".length), join(dir, entry.name));
    }
  }
  return [...groups.values()].map((files) => ({
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    mtime: Math.max(...files.map((f) => f.mtime)),
    size: files.reduce((n, f) => n + f.size, 0),
  }));
}

interface GateDrop {
  session: string;
  event: string;
  chars: number;
  at: number;
}

async function gateDrops(dataDir: string): Promise<GateDrop[]> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, "context-gate-log.json"), "utf-8")) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw.dropped)) return [];
    return raw.dropped.filter(isRecord).flatMap((d) =>
      typeof d.session === "string"
        ? [{ session: d.session, event: typeof d.event === "string" ? d.event : "?", chars: typeof d.chars === "number" ? d.chars : 0, at: typeof d.at === "number" ? d.at : 0 }]
        : []
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

const sumChars = (by: Record<string, McpServerCost>): number => Object.values(by).reduce((n, c) => n + c.chars, 0);

/**
 * Reads whole sessions, newest first, within the window and the byte budget. Local files only.
 * Only injections and gate drops stamped inside the window count.
 */
export async function buildLedger(opts: LedgerOptions): Promise<Ledger> {
  const now = opts.now ?? Date.now();
  const since = now - opts.days * DAY_MS;
  const maxBytes = opts.maxBytes ?? LEDGER_MAX_BYTES;
  const root = opts.projectRoot;
  const folderPrefix = root === null ? null : projectDirKey(root);
  const inScope = (cwd: string) => root === null || (opts.exact ? cwd === root : within(projectOf(cwd), root));

  // A symlinked alias of a project folder would be read twice.
  const folders = new Set<string>();
  const groups: SessionFiles[] = [];
  for (const dir of (await readdir(opts.projectsRoot).catch(() => [])).sort()) {
    if (folderPrefix !== null && !dir.startsWith(folderPrefix)) continue;
    const real = await realpath(join(opts.projectsRoot, dir)).catch(() => null);
    if (real === null || folders.has(real)) continue;
    folders.add(real);
    groups.push(...(await sessionFiles(real)));
  }
  const recent = groups
    .map((g) => ({ ...g, files: g.files.filter((f) => f.mtime >= since) }))
    .filter((g) => g.files.length > 0)
    .map((g) => ({ ...g, size: g.files.reduce((n, f) => n + f.size, 0) }))
    .sort((a, b) => b.mtime - a.mtime || a.files[0]!.path.localeCompare(b.files[0]!.path));

  const ledgers: TranscriptLedger[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let read = 0;
  let truncated = false;
  for (const group of recent) {
    if (bytes + group.size > maxBytes) {
      truncated = true;
      break;
    }
    for (const file of group.files) {
      const ledger = await parseTranscriptFile(file.path, { since });
      if (ledger === null) continue;
      bytes += file.size;
      read++;
      if (!ledger.sessionId || !ledger.cwd || (ledger.lastAt ?? file.mtime) < since || !inScope(ledger.cwd)) continue;
      const key = `${ledger.sessionId}\0${ledger.agentId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ledgers.push(ledger);
    }
  }

  const drops = (await gateDrops(opts.dataDir)).filter((d) => d.at >= since);
  const disabled = await pruned(opts.dataDir);
  const serverCost = new Map<string, number>();
  for (const l of ledgers) for (const [key, c] of Object.entries(l.mcpServerMax)) serverCost.set(key, Math.max(serverCost.get(key) ?? 0, c.chars));

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
    const mcpChars = sumChars(byServer);
    const agentChars = parts.filter((p) => p !== main).reduce((n, p) => n + sumChars(p.mcp), 0);
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
        compactions: main.compactions,
        byServer: Object.fromEntries(Object.entries(byServer).sort(([a], [b]) => a.localeCompare(b)).map(([n, s]) => [n, { tools: s.tools, tokens: estimateTokens(s.chars) }])),
      },
      pruned: prunedHere.map((name) => {
        const cost = serverCost.get(mcpServerKey(name));
        return { name, tokens: cost === undefined ? null : estimateTokens(cost) };
      }),
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
