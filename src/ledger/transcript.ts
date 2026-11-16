import { open, type FileHandle } from "node:fs/promises";

/**
 * The injection ledger: one pass over a Claude Code transcript (JSONL) that records what the
 * prompt-context hook injected, which of those hits the model went on to use, and what the
 * session's MCP set put into context. Read-only: it never writes and never sends anything.
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
  /**
   * The MCP set's context footprint, by server: every tool name and instruction announced in the
   * largest stretch between compactions, removals included (their text stays until the next one).
   */
  mcp: Record<string, McpServerCost>;
  /** Each server's own largest footprint in any segment, to price it where it was pruned. */
  mcpServerMax: Record<string, McpServerCost>;
  compactions: number;
}

/** Claude Code's spelling of a server inside `mcp__<server>__tool`: anything but [A-Za-z0-9_-] becomes `_`. */
export const mcpServerKey = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_");

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
  // Only a closing tag alone on its line ends the block: a snippet may quote one, indented.
  const close = `\n${INJECTION_CLOSE}`;
  for (let end = text.indexOf(close, start); end >= 0; end = text.indexOf(close, end + 1)) {
    const after = end + close.length;
    if (after === text.length || text[after] === "\n" || text[after] === "\r") return text.slice(start, after);
  }
  return text.slice(start);
}

/**
 * The MCP set within one stretch between compactions. Everything announced in a stretch stays in
 * context until the next compaction, so a removal never subtracts text already there; it only drops
 * the item from what carries over. A re-add after a removal is new text and counts again.
 */
class McpSegment {
  private readonly announced: Array<{ server: string; chars: number; tool: boolean }> = [];
  private readonly liveTools = new Map<string, { server: string; chars: number }>();
  private readonly liveInstructions = new Map<string, number>();

  /** The next stretch after a compaction: what was still live, announced once. */
  carryOver(): McpSegment {
    const next = new McpSegment();
    for (const [name, t] of this.liveTools) next.addTool(name, t.server, t.chars);
    for (const [server, chars] of this.liveInstructions) next.addInstructions(server, chars);
    return next;
  }

  private addTool(name: string, server: string, chars: number): void {
    if (this.liveTools.has(name)) return;
    this.liveTools.set(name, { server, chars });
    this.announced.push({ server, chars, tool: true });
  }

  private addInstructions(server: string, chars: number): void {
    if (this.liveInstructions.has(server)) return;
    this.liveInstructions.set(server, chars);
    this.announced.push({ server, chars, tool: false });
  }

  apply(a: Record<string, unknown>): void {
    if (a.type === "deferred_tools_delta") {
      for (const name of strings(a.removedNames)) this.liveTools.delete(name);
      const lines = strings(a.addedLines);
      strings(a.addedNames).forEach((name, i) => {
        const server = MCP_TOOL.exec(name)?.[1];
        if (server) this.addTool(name, mcpServerKey(server), (lines[i] ?? name).length + 1);
      });
    } else if (a.type === "mcp_instructions_delta") {
      for (const name of strings(a.removedNames)) this.liveInstructions.delete(mcpServerKey(name));
      const blocks = strings(a.addedBlocks);
      strings(a.addedNames).forEach((name, i) => this.addInstructions(mcpServerKey(name), (blocks[i] ?? "").length));
    }
  }

  byServer(): Record<string, McpServerCost> {
    const out: Record<string, McpServerCost> = {};
    for (const { server, chars, tool } of this.announced) {
      const c = (out[server] ??= { tools: 0, chars: 0 });
      if (tool) c.tools++;
      c.chars += chars;
    }
    return out;
  }
}

const total = (by: Record<string, McpServerCost>): number => Object.values(by).reduce((n, c) => n + c.chars, 0);

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

/**
 * Lines that can hold anything the ledger reads; the rest only carry a timestamp. A tool result
 * matters only when it answers a project-brain call, so those are matched by the call's id instead.
 */
const RELEVANT = [INJECTION_OPEN, '"tool_use"', '"type":"deferred_tools_delta"', '"type":"mcp_instructions_delta"', '"subtype":"compact_boundary"'].map((m) =>
  Buffer.from(m)
);
const TIMESTAMP = Buffer.from('"timestamp":"');
const NEWLINE = 0x0a;

/** What a usage keeps of a shell command or tool result: enough to find a path, bounded per line. */
const USAGE_TEXT_MAX = 64 * 1024;

/**
 * Where each marker next occurs in one chunk, found lazily and only moved forward, so testing every
 * line for every marker costs one pass over the chunk per marker, and no per-line object is made.
 */
class MarkerIndex {
  private readonly next = new Map<Buffer, number>();
  constructor(private readonly bytes: Buffer) {}

  /** Position of `marker` at or after `start`, or -1 when the chunk holds no more of it. */
  at(marker: Buffer, start: number): number {
    let p = this.next.get(marker);
    if (p === undefined || (p >= 0 && p < start)) {
      p = this.bytes.indexOf(marker, start);
      this.next.set(marker, p);
    }
    return p;
  }

  within(marker: Buffer, start: number, end: number): boolean {
    const p = this.at(marker, start);
    return p >= 0 && p + marker.length <= end;
  }
}

/**
 * Builds a ledger from a transcript fed in chunks, so a caller can stream a file of any size and
 * never hold it whole. Lines are searched as bytes and only the ones that matter are decoded.
 */
export class TranscriptReader {
  private readonly ledger: TranscriptLedger = { injections: [], hits: [], mcp: {}, mcpServerMax: {}, compactions: 0 };
  private readonly usages: Usage[] = [];
  private segment = new McpSegment();
  private readonly brainCalls = new Set<string>();
  private brainIds: Buffer[] = [];

  /**
   * Reads every complete line of `bytes`, which starts at byte `base` of the file, and returns where
   * the unfinished tail begins. `bytes` may be a buffer the caller reuses afterwards.
   */
  feed(bytes: Buffer, base: number): number {
    const markers = new MarkerIndex(bytes);
    let from = 0;
    for (let nl = bytes.indexOf(NEWLINE); nl >= 0; nl = bytes.indexOf(NEWLINE, from)) {
      this.line(bytes, from, nl, base + from, markers);
      from = nl + 1;
    }
    return from;
  }

  /** The project-brain call ids as bytes, rebuilt only when a call was added. */
  private brainCallIds(): Buffer[] {
    if (this.brainIds.length !== this.brainCalls.size) this.brainIds = [...this.brainCalls].map((id) => Buffer.from(`"${id}"`));
    return this.brainIds;
  }

  private line(bytes: Buffer, start: number, end: number, offset: number, markers: MarkerIndex): void {
    if (end - start < 2) return;
    const ledger = this.ledger;
    const ts = markers.at(TIMESTAMP, start);
    if (ts >= 0 && ts < end) {
      const from = ts + TIMESTAMP.length;
      const t = Date.parse(bytes.toString("latin1", from, Math.min(end, from + 40)).split('"')[0]!);
      if (Number.isFinite(t)) {
        ledger.firstAt ??= t;
        ledger.lastAt = t;
      }
    }
    const known = ledger.sessionId !== undefined && ledger.cwd !== undefined;
    if (known && !RELEVANT.some((m) => markers.within(m, start, end)) && !this.brainCallIds().some((id) => markers.within(id, start, end))) return;

    let o: unknown;
    try {
      o = JSON.parse(bytes.toString("utf-8", start, end));
    } catch {
      return;
    }
    if (!isRecord(o)) return;
    if (typeof o.sessionId === "string") ledger.sessionId ??= o.sessionId;
    if (typeof o.agentId === "string") ledger.agentId ??= o.agentId;
    if (typeof o.cwd === "string") ledger.cwd ??= o.cwd;

    if (o.type === "attachment" && isRecord(o.attachment)) {
      const block = injectedBlock(o.attachment);
      if (block) {
        const hits = parseInjection(block);
        const at = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
        if (hits.length > 0) ledger.injections.push({ line: offset, ...(Number.isFinite(at) ? { at } : {}), chars: block.length, hits });
      }
      this.segment.apply(o.attachment);
    } else if (o.type === "system" && o.subtype === "compact_boundary") {
      this.closeSegment();
      this.segment = this.segment.carryOver();
      ledger.compactions++;
    } else {
      for (const u of usagesOf(o, offset, this.brainCalls)) this.usages.push({ ...u, text: u.text.slice(0, USAGE_TEXT_MAX) });
    }
  }

  private closeSegment(): void {
    const by = this.segment.byServer();
    if (total(by) > total(this.ledger.mcp)) this.ledger.mcp = by;
    for (const [server, cost] of Object.entries(by)) {
      if (cost.chars > (this.ledger.mcpServerMax[server]?.chars ?? -1)) this.ledger.mcpServerMax[server] = cost;
    }
  }

  /** `since`: injections stamped before it are left out, with the hits only they brought. */
  finish(since = -Infinity): TranscriptLedger {
    const ledger = this.ledger;
    this.closeSegment();
    ledger.injections = ledger.injections.filter((i) => i.at === undefined || i.at >= since);
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
    ledger.hits = [];
    for (const { first, ...hit } of distinct.values()) {
      const kinds = new Set(this.usages.filter((u) => u.line > first && used(u, hit.source)).map((u) => u.kind));
      ledger.hits.push({ ...hit, used: [...kinds].sort() });
    }
    return ledger;
  }
}

const withNewline = (bytes: Buffer): Buffer => (bytes.length > 0 && bytes[bytes.length - 1] !== NEWLINE ? Buffer.concat([bytes, Buffer.from("\n")]) : bytes);

/** A transcript already in memory. `line` positions are byte offsets: ordered, not line numbers. */
export function parseTranscript(input: string | Uint8Array, since?: number): TranscriptLedger {
  const bytes = typeof input === "string" ? Buffer.from(input) : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const reader = new TranscriptReader();
  reader.feed(withNewline(bytes), 0);
  return reader.finish(since);
}

export const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * The lines decoded from transcripts are garbage at once, but the collector lets them pile up across
 * a large file or many small ones; collecting this often, counted across files, keeps the peak flat
 * for a few percent of the time.
 */
const GC_EVERY_BYTES = 4 * 1024 * 1024;
let readSinceCollect = 0;
function collectEvery(bytes: number): void {
  readSinceCollect += bytes;
  if (readSinceCollect < GC_EVERY_BYTES) return;
  readSinceCollect = 0;
  Bun.gc(true);
}

/**
 * A transcript on disk, read in fixed-size chunks into one reused buffer: memory stays at the chunk
 * plus the longest single line, whatever the file's size. Null when the file cannot be read.
 */
export async function parseTranscriptFile(path: string, opts: { since?: number; chunkBytes?: number } = {}): Promise<TranscriptLedger | null> {
  const { since, chunkBytes = READ_CHUNK_BYTES } = opts;
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  const reader = new TranscriptReader();
  const chunk = Buffer.allocUnsafe(chunkBytes);
  /** Copies of a line that spans chunks, fed once its newline arrives. */
  let pending: Buffer[] = [];
  let pendingStart = 0;
  let position = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunkBytes, position);
      if (bytesRead === 0) break;
      const bytes = chunk.subarray(0, bytesRead);
      let from = 0;
      if (pending.length > 0) {
        const nl = bytes.indexOf(NEWLINE);
        if (nl < 0) {
          pending.push(Buffer.from(bytes));
          position += bytesRead;
          continue;
        }
        reader.feed(Buffer.concat([...pending, bytes.subarray(0, nl + 1)]), pendingStart);
        pending = [];
        from = nl + 1;
      }
      const tail = from + reader.feed(bytes.subarray(from), position + from);
      if (tail < bytesRead) {
        pending = [Buffer.from(bytes.subarray(tail))];
        pendingStart = position + tail;
      }
      position += bytesRead;
      collectEvery(bytesRead);
    }
    if (pending.length > 0) reader.feed(withNewline(Buffer.concat(pending)), pendingStart);
    return reader.finish(since);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}
