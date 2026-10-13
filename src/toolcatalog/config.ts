import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The server name Claude Code derives its tool ids from: anything outside [a-zA-Z0-9_-] becomes `_`. */
export function normalizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export interface McpServerConfig {
  /** As written in the config; tool ids use {@link normalizeServerName} of it. */
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface ConfigOptions {
  home?: string;
  projectDir: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const entries = Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** One `mcpServers` entry → config, or null when disabled, unsupported (sse, ws) or unusable. */
function parseServer(name: string, raw: unknown): McpServerConfig | null {
  if (!isRecord(raw) || raw.disabled === true || raw.enabled === false) return null;
  const declared = typeof raw.type === "string" ? raw.type : undefined;
  if (typeof raw.command === "string" && raw.command && (declared === undefined || declared === "stdio")) {
    const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
    return { name, type: "stdio", command: raw.command, args, env: stringRecord(raw.env) };
  }
  if (typeof raw.url === "string" && raw.url && (declared === undefined || declared === "http")) {
    return { name, type: "http", url: raw.url };
  }
  return null;
}

function parseServers(block: unknown): McpServerConfig[] {
  if (!isRecord(block)) return [];
  return Object.entries(block).flatMap(([name, raw]) => {
    const server = parseServer(name, raw);
    return server ? [server] : [];
  });
}

/**
 * MCP servers the user has configured, highest precedence first: the project's
 * `.mcp.json`, the project entry and then the top level of `~/.claude.json`,
 * and `~/.claude/mcp-servers.json`. The first definition of a name wins.
 * project-brain itself is left out — its tools are already one hop away.
 * Never throws.
 */
export async function discoverMcpConfigs(opts: ConfigOptions): Promise<McpServerConfig[]> {
  const home = opts.home ?? homedir();
  const [project, user, extra] = await Promise.all([
    readJson(join(opts.projectDir, ".mcp.json")),
    readJson(join(home, ".claude.json")),
    readJson(join(home, ".claude", "mcp-servers.json")),
  ]);
  const projects = isRecord(user?.projects) ? user.projects : {};
  const projectEntry = projects[opts.projectDir];
  const blocks: unknown[] = [
    project?.mcpServers,
    isRecord(projectEntry) ? projectEntry.mcpServers : undefined,
    user?.mcpServers,
    extra?.mcpServers ?? extra,
  ];

  const seen = new Set<string>();
  return blocks
    .flatMap(parseServers)
    .filter((s) => normalizeServerName(s.name) !== "project-brain")
    .filter((s) => !seen.has(s.name) && seen.add(s.name));
}

/** Stable hash of what the catalog was built from; a changed server list or command line invalidates the cache. */
export function fingerprintConfigs(configs: McpServerConfig[]): string {
  const canonical = [...configs].sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha1").update(JSON.stringify(canonical)).digest("hex");
}
