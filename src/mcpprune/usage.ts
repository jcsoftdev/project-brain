import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { normalizeServerName } from "../toolcatalog/config.js";
import { projectDirKey, splitToolId } from "../toolcatalog/transcripts.js";

export type ToolKind = "configured" | "claude_ai" | "plugin" | "other";

/**
 * The server a tool id belongs to. Configured servers are matched by prefix
 * against their normalized names (longest wins), because a name may itself
 * contain `__`; claude.ai connectors and plugin servers are recognised by their
 * prefix and never match a configured name.
 */
export function classifyTool(toolId: string, configured: Iterable<string>): { server: string; kind: ToolKind } | null {
  const hit = [...configured]
    .map(normalizeServerName)
    .filter((n) => toolId.startsWith(`mcp__${n}__`))
    .sort((a, b) => b.length - a.length)[0];
  if (hit) return { server: hit, kind: "configured" };
  const split = splitToolId(toolId);
  if (!split) return null;
  if (split.server.startsWith("claude_ai_")) return { server: split.server, kind: "claude_ai" };
  if (split.server.startsWith("plugin_")) return { server: split.server, kind: "plugin" };
  return { server: split.server, kind: "other" };
}

export interface Usage {
  /** Full tool id → latest time (ms) it was called. */
  lastUsed: Map<string, number>;
  /** Top-level session transcripts; subagent transcripts belong to their session. */
  sessions: number;
  oldest: number | null;
  newest: number | null;
}

export const emptyUsage = (): Usage => ({ lastUsed: new Map(), sessions: 0, oldest: null, newest: null });

export function mergeUsage(into: Usage, from: Usage): Usage {
  for (const [tool, at] of from.lastUsed) if (at > (into.lastUsed.get(tool) ?? 0)) into.lastUsed.set(tool, at);
  into.sessions += from.sessions;
  if (from.oldest !== null) into.oldest = Math.min(into.oldest ?? from.oldest, from.oldest);
  if (from.newest !== null) into.newest = Math.max(into.newest ?? from.newest, from.newest);
  return into;
}

async function walk(dir: string, top: boolean): Promise<Array<{ file: string; mtime: number; top: boolean }>> {
  const out: Array<{ file: string; mtime: number; top: boolean }> = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(path, false)));
    else if (e.name.endsWith(".jsonl")) {
      const mtime = await stat(path).then((s) => s.mtimeMs, () => null);
      if (mtime !== null) out.push({ file: path, mtime, top });
    }
  }
  return out;
}

const MARKER = '"name":"mcp__';

function toolCalls(line: string, fallback: number): Array<[string, number]> {
  try {
    const obj = JSON.parse(line) as { timestamp?: unknown; message?: { content?: unknown } };
    const content = obj.message?.content;
    if (!Array.isArray(content)) return [];
    const at = typeof obj.timestamp === "string" && !Number.isNaN(Date.parse(obj.timestamp)) ? Date.parse(obj.timestamp) : fallback;
    return content.flatMap((c: { type?: unknown; name?: unknown }) =>
      c?.type === "tool_use" && typeof c.name === "string" && c.name.startsWith("mcp__") ? [[c.name, at] as [string, number]] : []
    );
  } catch {
    return [];
  }
}

/**
 * `tool_use` calls to MCP tools in one project's transcripts. Only transcripts
 * touched since `sinceMs` are read, since an older one cannot hold a newer call.
 */
export async function scanUsage(projectsRoot: string, projectDir: string, sinceMs: number): Promise<Usage> {
  const usage = emptyUsage();
  for (const f of await walk(join(projectsRoot, projectDirKey(projectDir)), true)) {
    if (f.top) usage.sessions++;
    usage.oldest = Math.min(usage.oldest ?? f.mtime, f.mtime);
    usage.newest = Math.max(usage.newest ?? f.mtime, f.mtime);
    if (f.mtime < sinceMs) continue;
    let text: string;
    try {
      text = await readFile(f.file, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes(MARKER)) continue;
      for (const [tool, at] of toolCalls(line, f.mtime)) if (at > (usage.lastUsed.get(tool) ?? 0)) usage.lastUsed.set(tool, at);
    }
  }
  return usage;
}
