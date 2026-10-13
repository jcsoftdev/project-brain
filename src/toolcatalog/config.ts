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

/**
 * Servers split by what they depend on. `user` is the same for every project;
 * `project` is this project's local-scope entries plus the approved `.mcp.json`
 * ones and overrides `user` by name. `disabled` are normalized names the user
 * switched off for this project, whatever scope defines them.
 */
export interface McpConfigs {
  user: McpServerConfig[];
  project: McpServerConfig[];
  disabled: string[];
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

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** One `mcpServers` entry → config, or null when disabled, unsupported (sse, ws) or unusable. */
function parseServer(name: string, raw: unknown): McpServerConfig | null {
  if (!isRecord(raw) || raw.disabled === true || raw.enabled === false) return null;
  const declared = typeof raw.type === "string" ? raw.type : undefined;
  if (typeof raw.command === "string" && raw.command && (declared === undefined || declared === "stdio")) {
    return { name, type: "stdio", command: raw.command, args: stringList(raw.args), env: stringRecord(raw.env) };
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

/** First definition of a name wins; project-brain itself is dropped, its tools are already one hop away. */
function dedupe(servers: McpServerConfig[]): McpServerConfig[] {
  const seen = new Set<string>();
  return servers
    .filter((s) => normalizeServerName(s.name) !== "project-brain")
    .filter((s) => !seen.has(s.name) && seen.add(s.name));
}

interface Approvals {
  enableAll: boolean;
  enabled: Set<string>;
  disabledJson: Set<string>;
}

/**
 * Claude Code runs a project `.mcp.json` server only after the user approved
 * it. Approvals live in the project's entry of ~/.claude.json and in the
 * settings files; any source enabling a server enables it, any source
 * disabling it wins.
 */
function readApprovals(sources: Array<Record<string, unknown> | null | undefined>): Approvals {
  const out: Approvals = { enableAll: false, enabled: new Set(), disabledJson: new Set() };
  for (const src of sources) {
    if (!src) continue;
    if (src.enableAllProjectMcpServers === true) out.enableAll = true;
    stringList(src.enabledMcpjsonServers).forEach((n) => out.enabled.add(n));
    stringList(src.disabledMcpjsonServers).forEach((n) => out.disabledJson.add(n));
  }
  return out;
}

/**
 * MCP servers Claude Code would run for this project, following its scope
 * order — local (`projects[dir].mcpServers`) over project (`.mcp.json`, only
 * if approved) over user (`~/.claude.json` top level, then
 * `~/.claude/mcp-servers.json`). Never throws.
 */
export async function discoverMcpConfigs(opts: ConfigOptions): Promise<McpConfigs> {
  const home = opts.home ?? homedir();
  const [mcpJson, claudeJson, extra, userSettings, projectSettings, localSettings] = await Promise.all([
    readJson(join(opts.projectDir, ".mcp.json")),
    readJson(join(home, ".claude.json")),
    readJson(join(home, ".claude", "mcp-servers.json")),
    readJson(join(home, ".claude", "settings.json")),
    readJson(join(opts.projectDir, ".claude", "settings.json")),
    readJson(join(opts.projectDir, ".claude", "settings.local.json")),
  ]);
  const projects = isRecord(claudeJson?.projects) ? claudeJson.projects : {};
  const entry = isRecord(projects[opts.projectDir]) ? (projects[opts.projectDir] as Record<string, unknown>) : null;

  const approvals = readApprovals([entry, userSettings, projectSettings, localSettings]);
  const approved = (s: McpServerConfig): boolean =>
    !approvals.disabledJson.has(s.name) && (approvals.enableAll || approvals.enabled.has(s.name));

  const disabled = new Set(stringList(entry?.disabledMcpServers).map(normalizeServerName));
  const notDisabled = (s: McpServerConfig): boolean => !disabled.has(normalizeServerName(s.name));

  return {
    user: dedupe([...parseServers(claudeJson?.mcpServers), ...parseServers(extra?.mcpServers ?? extra)]).filter(notDisabled),
    project: dedupe([...parseServers(entry?.mcpServers), ...parseServers(mcpJson?.mcpServers).filter(approved)]).filter(notDisabled),
    disabled: [...disabled].sort(),
  };
}

/** Stable hash of what a catalog part was built from; a changed server list or command line invalidates it. */
export function fingerprintConfigs(configs: McpServerConfig[], extra: string[] = []): string {
  const canonical = [...configs].sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha1").update(JSON.stringify([canonical, extra])).digest("hex");
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** `${VAR}` and `${VAR:-default}` as Claude Code expands them; throws when a variable is unset and has no default. */
export function expandVars(text: string, env: Record<string, string | undefined> = process.env): string {
  return text.replace(VAR, (_m, name: string, fallback: string | undefined) => {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
    if (fallback !== undefined) return fallback;
    throw new Error(`unset variable ${name}`);
  });
}

/** The server with variables expanded in command, args, env values and url. Throws like {@link expandVars}. */
export function expandServer(server: McpServerConfig, env: Record<string, string | undefined> = process.env): McpServerConfig {
  const expand = (t: string): string => expandVars(t, env);
  return {
    ...server,
    command: server.command === undefined ? undefined : expand(server.command),
    args: server.args?.map(expand),
    env: server.env ? Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, expand(v)])) : undefined,
    url: server.url === undefined ? undefined : expand(server.url),
  };
}
