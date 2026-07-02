import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LanceDbStore } from "./store/lancedb.js";
import { createEmbeddingClient } from "./embeddings/factory.js";
import { makeEmbeddingResolver } from "./embeddings/resolver.js";
import { DB_PATH, OLLAMA_HOST, VERSION, SERVER_INSTRUCTIONS, GRAPH_DB_FILE } from "./constants.js";
import { register as registerSearch } from "./tools/search.js";
import { register as registerSearchCode } from "./tools/search-code.js";
import { register as registerIngest } from "./tools/ingest.js";
import { register as registerModules } from "./tools/modules.js";
import { register as registerForget } from "./tools/forget.js";
import { register as registerHealth } from "./tools/health.js";
import { register as registerExpand } from "./tools/expand.js";
import { register as registerFindSymbol } from "./tools/find-symbol.js";
import { register as registerCallgraph } from "./tools/callgraph.js";
import { register as registerImpact } from "./tools/impact.js";
import { register as registerTracePath } from "./tools/trace-path.js";
import { register as registerProjects } from "./tools/projects.js";
import { register as registerAdr } from "./tools/adr.js";
import { register as registerArchitecture } from "./tools/architecture.js";
import { register as registerSyncProject } from "./tools/sync-project.js";
import { openGraphDb } from "./graph/db.js";
import { GraphStore } from "./graph/store.js";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { EmbeddingClient, ToolDeps } from "./types.js";

interface ServerOptions {
  dbPath?: string;
  ollamaHost?: string;
  embedModel?: string;
  /** Injectable embeddings client — when provided, skips the startup probe entirely. */
  embeddings?: EmbeddingClient;
  /**
   * Project root whose .project-brain/graph.db holds the structural graph.
   * Defaults to process.cwd(). The graph MUST live at the project-local path
   * so the served structural tools read the SAME db that runSync writes.
   */
  projectRoot?: string;
}

/** Create and configure the MCP server with all tools registered. */
export async function createServer(options: ServerOptions = {}) {
  const dbPath = options.dbPath || DB_PATH;
  const ollamaHost = options.ollamaHost || OLLAMA_HOST;

  const server = new McpServer(
    { name: "project-brain", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  const store = new LanceDbStore(dbPath);
  const embeddings = options.embeddings ?? await createEmbeddingClient(
    options.embedModel || process.env.BRAIN_EMBED_MODEL || undefined,
    { host: ollamaHost, autoPull: false }
  );

  const embeddingsFor = makeEmbeddingResolver({
    dbPath,
    host: ollamaHost,
    defaultClient: embeddings,
  });

  mkdirSync(dbPath, { recursive: true });
  // Structural graph lives at the PROJECT-LOCAL path (not the global data dir)
  // so the served tools query the same graph.db that runSync/the watcher write.
  const projectRoot = options.projectRoot || process.cwd();
  const graphDir = join(projectRoot, ".project-brain");
  mkdirSync(graphDir, { recursive: true });
  const graphPath = join(graphDir, GRAPH_DB_FILE);
  const graph = new GraphStore(openGraphDb(graphPath));

  // Capability-gated destructive confirmation via MCP elicitation (2026 spec).
  // getClientCapabilities() is only populated after initialization, so the
  // gate is evaluated per-call, not at startup.
  const confirmDestructive = async (message: string): Promise<boolean> => {
    const caps = server.server.getClientCapabilities();
    if (!caps?.elicitation) return true; // no capability → today's behavior
    const res = await server.server.elicitInput({
      message,
      requestedSchema: {
        type: "object",
        properties: { confirm: { type: "boolean", title: "Confirm deletion" } },
        required: ["confirm"],
      },
    });
    return res.action === "accept" && res.content?.confirm === true;
  };

  const deps: ToolDeps = { store, embeddings, embeddingsFor, graph, confirmDestructive, projectRoot };

  // Register all tools
  registerSearch(server, deps);
  registerSearchCode(server, deps);
  registerIngest(server, deps);
  registerModules(server, deps);
  registerForget(server, deps);
  registerHealth(server, deps);
  registerExpand(server, deps);
  registerFindSymbol(server, deps);
  registerCallgraph(server, deps);
  registerImpact(server, deps);
  registerTracePath(server, deps);
  registerProjects(server, deps);
  registerAdr(server, deps);
  registerArchitecture(server, deps);
  registerSyncProject(server, deps);

  const toolNames = [
    "search_context",
    "search_code",
    "add_knowledge",
    "list_modules",
    "get_module",
    "delete_knowledge",
    "check_health",
    "expand_context",
    "find_symbol",
    "find_callers",
    "find_callees",
    "impact",
    "trace_path",
    "list_projects",
    "delete_project",
    "manage_adr",
    "get_architecture",
    "sync_project",
  ];

  return { server, store, embeddings, graph, toolNames, instructions: SERVER_INSTRUCTIONS };
}
