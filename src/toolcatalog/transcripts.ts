import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolEntry } from "./live.js";

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
  return `${label}: ${tool.replace(/[_-]+/g, " ").trim()}`;
}

function namesFromLine(line: string): string[] {
  try {
    const entry = JSON.parse(line) as { attachment?: { type?: unknown; addedNames?: unknown } };
    const att = entry.attachment;
    if (att?.type !== MARKER || !Array.isArray(att.addedNames)) return [];
    return att.addedNames.filter((n): n is string => typeof n === "string" && n.startsWith("mcp__"));
  } catch {
    return [];
  }
}

async function newestTranscripts(root: string): Promise<string[]> {
  try {
    const files: Array<{ file: string; mtime: number }> = [];
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
          files.push({ file, mtime: (await stat(file)).mtimeMs });
        } catch {
          // Vanished between readdir and stat.
        }
      }
    }
    return files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_TRANSCRIPTS).map((f) => f.file);
  } catch {
    return [];
  }
}

/**
 * Name-only entries for every `mcp__*` tool Claude Code announced in recent
 * transcripts' `deferred_tools_delta` attachments, skipping servers in
 * `exclude` (normalized names — the ones already listed live) and
 * project-brain. Never throws.
 */
export async function scanTranscriptTools(exclude: Set<string>, home: string = homedir()): Promise<ToolEntry[]> {
  const byName = new Map<string, ToolEntry>();
  for (const file of await newestTranscripts(join(home, ".claude", "projects"))) {
    let text: string;
    try {
      text = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes(MARKER)) continue;
      for (const name of namesFromLine(line)) {
        const parts = splitToolId(name);
        if (!parts || exclude.has(parts.server) || parts.server === "project-brain" || byName.has(name)) continue;
        byName.set(name, { name, server: parts.server, description: describeFromName(parts.server, parts.tool), nameOnly: true });
      }
    }
  }
  return [...byName.values()];
}
