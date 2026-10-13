import { expandServer, normalizeServerName, type McpServerConfig } from "./config.js";

export interface ToolEntry {
  /** Claude Code's tool id: `mcp__<server>__<tool>`. */
  name: string;
  server: string;
  description: string;
  /** True when only the name is known (transcript fallback). */
  nameOnly?: boolean;
}

/** Lists one server's tools; rejects on any failure. Injectable so tests never spawn a server. */
export type ToolLister = (server: McpServerConfig) => Promise<ToolEntry[]>;

/** Budget per server, connect + list. A slow server costs the refresh this much and nothing else. */
export const SERVER_TIMEOUT_MS = 10_000;

/** Servers listed at once; each stdio server is a child process. */
export const LIST_CONCURRENCY = 4;

const MAX_LIST_PAGES = 5;

/** Control characters out (they would reach Jev and the injected context), whitespace collapsed. */
export const collapse = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();

/** Tool names that cannot be a real MCP tool id are dropped rather than suggested. */
export const VALID_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function toolId(server: string, tool: string): string {
  return `mcp__${normalizeServerName(server)}__${tool}`;
}

function mergedEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  return { ...base, ...extra };
}

/**
 * `npx`/`uvx`-style servers run the real process as a grandchild that the
 * transport's SIGTERM to the direct child does not reach, and the SDK gives no
 * way to start the child as a group leader. Best effort: signal the
 * descendants before the transport closes. No-op on Windows or without pgrep.
 */
function killDescendants(pid: number | null): void {
  if (!pid || process.platform === "win32") return;
  try {
    const out = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString();
    for (const child of out.split("\n").map(Number).filter(Boolean)) {
      killDescendants(child);
      try {
        process.kill(child, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  } catch {
    // Best effort.
  }
}

/**
 * Connects with the MCP SDK client, pages through `tools/list` and always
 * closes the transport (which kills a stdio child). HTTP servers are tried
 * without credentials, so an OAuth-protected one fails with 401 and is skipped
 * by the caller. `${VAR}` references in the config are expanded first; an
 * unset one fails the server like Claude Code does.
 */
export const listServerTools: ToolLister = async (configured) => {
  const server = expandServer(configured);
  const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  const transport =
    server.type === "http"
      ? new StreamableHTTPClientTransport(new URL(server.url!))
      : new StdioClientTransport({
          command: server.command!,
          args: server.args ?? [],
          env: mergedEnv(server.env),
          stderr: "ignore",
        });
  const client = new Client({ name: "project-brain-tool-catalog", version: "1.0.0" }, { capabilities: {} });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = (async () => {
      await client.connect(transport);
      const tools: ToolEntry[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const res = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of res.tools) {
          if (!VALID_TOOL_NAME.test(t.name)) continue;
          tools.push({ name: toolId(server.name, t.name), server: normalizeServerName(server.name), description: collapse(t.description ?? "") });
        }
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return tools;
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${SERVER_TIMEOUT_MS}ms`)), SERVER_TIMEOUT_MS);
    });
    // The run keeps going after a timeout; swallow its eventual rejection.
    run.catch(() => {});
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
    killDescendants(transport instanceof StdioClientTransport ? transport.pid : null);
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
};

export interface LiveResult {
  tools: ToolEntry[];
  /** Normalized names of servers that answered (even with zero tools). */
  listed: Set<string>;
}

/** Lists every server with bounded concurrency; a failing server is skipped. Never throws. */
export async function listAllServers(
  servers: McpServerConfig[],
  lister: ToolLister = listServerTools,
  concurrency = LIST_CONCURRENCY
): Promise<LiveResult> {
  const results: Array<ToolEntry[] | null> = new Array(servers.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < servers.length) {
      const i = next++;
      try {
        results[i] = await lister(servers[i]!);
      } catch {
        results[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, servers.length) }, worker));

  const listed = new Set<string>();
  const tools: ToolEntry[] = [];
  results.forEach((r, i) => {
    if (!r) return;
    listed.add(normalizeServerName(servers[i]!.name));
    tools.push(...r);
  });
  return { tools, listed };
}
