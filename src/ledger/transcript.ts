/**
 * The injection ledger: one pass over a Claude Code transcript (JSONL) that records what the
 * prompt-context hook injected, which of those hits the model went on to use, and what the
 * session's MCP set put into context. Pure: text in, ledger out; reading files is the caller's.
 */

export const INJECTION_OPEN = "<project-brain: relevant context for this prompt>";
export const INJECTION_CLOSE = "</project-brain>";

/** How a later step in the same transcript touched an injected hit. */
export type UsageKind = "read" | "edit" | "bash" | "project-brain";

export interface InjectedHit {
  source: string;
  startLine?: number;
  endLine?: number;
  score: number;
  /** The hit's line plus its snippet lines, as printed. */
  chars: number;
}

export interface Injection {
  /** Byte offset of the hook output in the transcript; usage counts only after it. */
  line: number;
  at?: number;
  chars: number;
  hits: InjectedHit[];
}

/** One distinct injected hit (same source and range) with how it was used after it first appeared. */
export interface HitUsage {
  source: string;
  startLine?: number;
  /** Highest score it was injected with. */
  score: number;
  injections: number;
  used: UsageKind[];
}

export interface McpServerCost {
  tools: number;
  chars: number;
}

export interface TranscriptLedger {
  sessionId?: string;
  agentId?: string;
  cwd?: string;
  firstAt?: number;
  lastAt?: number;
  injections: Injection[];
  hits: HitUsage[];
  /** MCP tool names and server instructions the session's deltas added, by server. */
  mcp: Record<string, McpServerCost>;
}

const HIT_LINE = /^- (.+?)(?: › .+?)?(?: \(L(\d+)-(\d+)\))? \[score (\d+(?:\.\d+)?)\]$/;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PROJECT_BRAIN_TOOL = /^mcp__(?:plugin_)?project-brain[^_]*__/;
const MCP_TOOL = /^mcp__(.+?)__/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The hits of one injected block; lines that are not a hit header belong to the hit above them. */
export function parseInjection(block: string): InjectedHit[] {
  const hits: InjectedHit[] = [];
  for (const line of block.split("\n")) {
    if (line === INJECTION_OPEN || line === INJECTION_CLOSE) continue;
    const m = HIT_LINE.exec(line);
    if (m) {
      hits.push({
        source: m[1]!,
        ...(m[2] ? { startLine: Number(m[2]), endLine: Number(m[3]) } : {}),
        score: Number(m[4]),
        chars: line.length + 1,
      });
    } else if (hits.length > 0) {
      hits[hits.length - 1]!.chars += line.length + 1;
    }
  }
  return hits;
}

function injectedBlock(attachment: unknown): string | null {
  if (!isRecord(attachment) || attachment.hookEvent !== "UserPromptSubmit") return null;
  const values = [...(Array.isArray(attachment.content) ? attachment.content : [attachment.content]), attachment.stdout];
  const text = values.find((v): v is string => typeof v === "string" && v.includes(INJECTION_OPEN));
  if (!text) return null;
  const start = text.indexOf(INJECTION_OPEN);
  const end = text.indexOf(INJECTION_CLOSE, start);
  return text.slice(start, end < 0 ? undefined : end + INJECTION_CLOSE.length);
}

function addMcp(mcp: Record<string, McpServerCost>, server: string, chars: number, tools: number): void {
  const cost = (mcp[server] ??= { tools: 0, chars: 0 });
  cost.tools += tools;
  cost.chars += chars;
}

/** Deltas only ever append to context, so a name removed later still cost what it added. */
function recordDelta(mcp: Record<string, McpServerCost>, a: Record<string, unknown>): void {
  if (a.type === "deferred_tools_delta") {
    const lines = strings(a.addedLines);
    strings(a.addedNames).forEach((name, i) => {
      const server = MCP_TOOL.exec(name)?.[1];
      if (server) addMcp(mcp, server, (lines[i] ?? name).length + 1, 1);
    });
  } else if (a.type === "mcp_instructions_delta") {
    const blocks = strings(a.addedBlocks);
    strings(a.addedNames).forEach((name, i) => addMcp(mcp, name, (blocks[i] ?? "").length, 0));
  }
}

interface Usage {
  line: number;
  kind: UsageKind;
  text: string;
}

const boundary = (c: string | undefined) => c === undefined || !/[\w.-]/.test(c);

/** Whether `text` names `source` as a whole path or as the tail of one (`/abs/…/src/x.ts`, `src/x.ts:12`). */
export function mentions(text: string, source: string): boolean {
  for (let i = text.indexOf(source); i >= 0; i = text.indexOf(source, i + 1)) {
    if (boundary(text[i - 1]) && boundary(text[i + source.length])) return true;
  }
  return false;
}

function usagesOf(o: Record<string, unknown>, line: number, brainCalls: Set<string>): Usage[] {
  const content = isRecord(o.message) && Array.isArray(o.message.content) ? o.message.content : [];
  const out: Usage[] = [];
  for (const c of content) {
    if (!isRecord(c)) continue;
    if (c.type === "tool_use" && typeof c.name === "string") {
      const input = isRecord(c.input) ? c.input : {};
      const path = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : "";
      if (c.name === "Read" && path) out.push({ line, kind: "read", text: path });
      else if (EDIT_TOOLS.has(c.name) && path) out.push({ line, kind: "edit", text: path });
      else if (c.name === "Bash" && typeof input.command === "string") out.push({ line, kind: "bash", text: input.command });
      if (PROJECT_BRAIN_TOOL.test(c.name) && typeof c.id === "string") brainCalls.add(c.id);
    } else if (c.type === "tool_result" && typeof c.tool_use_id === "string" && brainCalls.has(c.tool_use_id)) {
      out.push({ line, kind: "project-brain", text: typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "") });
    }
  }
  return out;
}

function used(u: Usage, source: string): boolean {
  if (u.kind === "read" || u.kind === "edit") return u.text === source || u.text.endsWith(`/${source}`);
  return mentions(u.text, source);
}

/** Lines that can hold anything the ledger reads; the rest only carry a timestamp. */
const RELEVANT = [INJECTION_OPEN, '"tool_use"', '"tool_result"', "_delta"].map((m) => Buffer.from(m));
const TIMESTAMP = Buffer.from('"timestamp":"');
const NEWLINE = 0x0a;

/** Found by byte search, so a line that is skipped is never decoded. */
function timestampOf(line: Buffer): number | undefined {
  const i = line.indexOf(TIMESTAMP);
  if (i < 0) return undefined;
  const from = i + TIMESTAMP.length;
  const t = Date.parse(line.toString("latin1", from, Math.min(line.length, from + 40)).split('"')[0]!);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Accepts the raw file so a multi-hundred-megabyte transcript is searched as bytes and only the
 * lines that matter are decoded. `line` positions are byte offsets: ordered, not line numbers.
 */
export function parseTranscript(input: string | Uint8Array): TranscriptLedger {
  const bytes = typeof input === "string" ? Buffer.from(input) : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const ledger: TranscriptLedger = { injections: [], hits: [], mcp: {} };
  const usages: Usage[] = [];
  const brainCalls = new Set<string>();

  for (let line = 0; line < bytes.length; ) {
    const newline = bytes.indexOf(NEWLINE, line);
    const end = newline < 0 ? bytes.length : newline;
    const start = line;
    line = end + 1;
    if (end - start < 2) continue;
    // A view, so every search below stays inside this line.
    const view = bytes.subarray(start, end);
    const at = timestampOf(view);
    if (at !== undefined) {
      ledger.firstAt ??= at;
      ledger.lastAt = at;
    }
    if (ledger.sessionId !== undefined && ledger.cwd !== undefined && !RELEVANT.some((m) => view.includes(m))) continue;
    const raw = view.toString("utf-8");

    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(o)) continue;
    if (typeof o.sessionId === "string") ledger.sessionId ??= o.sessionId;
    if (typeof o.agentId === "string") ledger.agentId ??= o.agentId;
    if (typeof o.cwd === "string") ledger.cwd ??= o.cwd;

    if (o.type === "attachment" && isRecord(o.attachment)) {
      const block = injectedBlock(o.attachment);
      if (block) {
        const hits = parseInjection(block);
        if (hits.length > 0) ledger.injections.push({ line: start, ...(at !== undefined ? { at } : {}), chars: block.length, hits });
      }
      recordDelta(ledger.mcp, o.attachment);
    } else {
      usages.push(...usagesOf(o, start, brainCalls));
    }
  }

  const distinct = new Map<string, HitUsage & { first: number }>();
  for (const injection of ledger.injections) {
    for (const hit of injection.hits) {
      const key = `${hit.source}\0${hit.startLine ?? ""}`;
      const seen = distinct.get(key);
      if (seen) {
        seen.injections++;
        seen.score = Math.max(seen.score, hit.score);
      } else {
        distinct.set(key, { source: hit.source, ...(hit.startLine !== undefined ? { startLine: hit.startLine } : {}), score: hit.score, injections: 1, used: [], first: injection.line });
      }
    }
  }
  for (const { first, ...hit } of distinct.values()) {
    const kinds = new Set(usages.filter((u) => u.line > first && used(u, hit.source)).map((u) => u.kind));
    ledger.hits.push({ ...hit, used: [...kinds].sort() });
  }
  return ledger;
}
