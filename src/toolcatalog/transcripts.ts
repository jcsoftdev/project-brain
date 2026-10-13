import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { collapse, VALID_TOOL_NAME, type ToolEntry } from "./live.js";

/** Most recent transcripts scanned; deferred-tool lists repeat session after session, so recent ones suffice. */
export const MAX_TRANSCRIPTS = 20;

/** Cheap pre-filter: only lines carrying this marker are JSON-parsed. */
const MARKER = "deferred_tools_delta";

/** `mcp__claude_ai_Slack__slack_send_message` → server `claude_ai_Slack`, tool `slack_send_message`. */
export function splitToolId(id: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(id);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

/** Readable stand-in for a description: `Slack: slack send message`. */
export function describeFromName(server: string, tool: string): string {
  const label = server.replace(/^claude_ai_/, "").replace(/[_-]+/g, " ").trim();
  return collapse(`${label}: ${tool.replace(/[_-]+/g, " ")}`);
}

/**
 * Transcripts also announce servers the assistant cannot call from here:
 * per-session UUID servers and `ccd_*` ones. Only claude.ai connectors, plugin
 * servers and servers present in the user's config are suggested.
 */
export function isCallableServer(server: string, configured: Set<string>): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(server) || server.startsWith("ccd_")) return false;
  return server.startsWith("claude_ai_") || server.startsWith("plugin_") || configured.has(server);
}

interface Delta {
  added: string[];
  removed: string[];
}

function deltaFromLine(line: string): Delta | null {
  try {
    const att = (JSON.parse(line) as { attachment?: { type?: unknown; addedNames?: unknown; removedNames?: unknown } }).attachment;
    if (att?.type !== MARKER) return null;
    const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((n): n is string => typeof n === "string" && n.startsWith("mcp__")) : []);
    return { added: names(att.addedNames), removed: names(att.removedNames) };
  } catch {
    return null;
  }
}

/** Claude Code keys a project's transcript directory by its path with every non-alphanumeric turned into `-`. */
export const projectDirKey = (projectDir: string): string => projectDir.replace(/[^a-zA-Z0-9]/g, "-");

/** Newest {@link MAX_TRANSCRIPTS} transcripts, this project's first, returned oldest first so deltas replay in order. */
async function pickTranscripts(root: string, projectDir: string | undefined): Promise<string[]> {
  const own = projectDir ? projectDirKey(projectDir) : undefined;
  try {
    const files: Array<{ file: string; mtime: number; own: boolean }> = [];
    for (const dir of await readdir(root)) {
      let entries: string[] = [];
      try {
        entries = await readdir(join(root, dir));
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const file = join(root, dir, name);
        try {
          files.push({ file, mtime: (await stat(file)).mtimeMs, own: dir === own });
        } catch {
          // Vanished between readdir and stat.
        }
      }
    }
    return files
      .sort((a, b) => Number(b.own) - Number(a.own) || b.mtime - a.mtime)
      .slice(0, MAX_TRANSCRIPTS)
      .sort((a, b) => a.mtime - b.mtime)
      .map((f) => f.file);
  } catch {
    return [];
  }
}

export interface TranscriptOptions {
  home?: string;
  /** Prefer this project's transcripts. */
  projectDir?: string;
  /** Normalized names of servers already listed live. */
  exclude?: Set<string>;
  /** Normalized names of servers in the user's config; they are callable even without a `claude_ai_` prefix. */
  configured?: Set<string>;
}

/**
 * Name-only entries for the `mcp__*` tools Claude Code announced in recent
 * transcripts' `deferred_tools_delta` attachments, replaying `addedNames` and
 * `removedNames` in order. Servers already listed live, project-brain and
 * servers that cannot be called (see {@link isCallableServer}) are left out.
 * Never throws.
 */
export async function scanTranscriptTools(opts: TranscriptOptions = {}): Promise<ToolEntry[]> {
  const exclude = opts.exclude ?? new Set<string>();
  const configured = opts.configured ?? new Set<string>();
  const current = new Set<string>();
  for (const file of await pickTranscripts(join(opts.home ?? homedir(), ".claude", "projects"), opts.projectDir)) {
    let text: string;
    try {
      text = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes(MARKER)) continue;
      const delta = deltaFromLine(line);
      delta?.added.forEach((n) => current.add(n));
      delta?.removed.forEach((n) => current.delete(n));
    }
  }

  const entries: ToolEntry[] = [];
  for (const name of current) {
    const parts = splitToolId(name);
    if (!parts || !VALID_TOOL_NAME.test(parts.tool) || exclude.has(parts.server) || parts.server === "project-brain") continue;
    if (!isCallableServer(parts.server, configured)) continue;
    entries.push({ name, server: parts.server, description: describeFromName(parts.server, parts.tool), nameOnly: true });
  }
  return entries;
}
