import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LanceDbStore } from "./store/lancedb.js";
import { createEmbeddingClient } from "./embeddings/factory.js";
import { DB_PATH, OLLAMA_HOST, VERSION } from "./constants.js";
import { register as registerSearch } from "./tools/search.js";
import { register as registerIngest } from "./tools/ingest.js";
import { register as registerModules } from "./tools/modules.js";
import { register as registerForget } from "./tools/forget.js";
import { register as registerHealth } from "./tools/health.js";
import { register as registerExpand } from "./tools/expand.js";
import type { ToolDeps } from "./types.js";

interface ServerOptions {
  dbPath?: string;
  ollamaHost?: string;
  embedModel?: string;
}

/** Create and configure the MCP server with all tools registered. */
export async function createServer(options: ServerOptions = {}) {
  const dbPath = options.dbPath || DB_PATH;
  const ollamaHost = options.ollamaHost || OLLAMA_HOST;

  const server = new McpServer({
    name: "project-brain",
    version: VERSION,
  });

  const store = new LanceDbStore(dbPath);
  const embeddings = await createEmbeddingClient(undefined, { host: ollamaHost });

  const deps: ToolDeps = { store, embeddings };

  // Register all tools
  registerSearch(server, deps);
  registerIngest(server, deps);
  registerModules(server, deps);
  registerForget(server, deps);
  registerHealth(server, deps);
  registerExpand(server, deps);

  const toolNames = [
    "search_context",
    "add_knowledge",
    "list_modules",
    "get_module",
    "delete_knowledge",
    "check_health",
    "expand_context",
  ];

  return { server, store, embeddings, toolNames };
}
