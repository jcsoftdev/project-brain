import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LanceDbStore } from "./store/lancedb.js";
import { createEmbeddingClient } from "./embeddings/factory.js";
import { makeEmbeddingResolver } from "./embeddings/resolver.js";
import { DB_PATH, OLLAMA_HOST, VERSION, SERVER_INSTRUCTIONS, GRAPH_DB_FILE } from "./constants.js";
import { register as registerSearch } from "./tools/search.js";
import { register as registerIngest } from "./tools/ingest.js";
import { register as registerModules } from "./tools/modules.js";
import { register as registerForget } from "./tools/forget.js";
import { register as registerHealth } from "./tools/health.js";
import { register as registerExpand } from "./tools/expand.js";
import { register as registerFindSymbol } from "./tools/find-symbol.js";
import { register as registerCallgraph } from "./tools/callgraph.js";
import { register as registerImpact } from "./tools/impact.js";
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
  const graphPath = join(dbPath, GRAPH_DB_FILE);
  const graph = new GraphStore(openGraphDb(graphPath));

  const deps: ToolDeps = { store, embeddings, embeddingsFor, graph };

  // Register all tools
  registerSearch(server, deps);
  registerIngest(server, deps);
  registerModules(server, deps);
  registerForget(server, deps);
  registerHealth(server, deps);
  registerExpand(server, deps);
  registerFindSymbol(server, deps);
  registerCallgraph(server, deps);
  registerImpact(server, deps);

  const toolNames = [
    "search_context",
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
  ];

  return { server, store, embeddings, toolNames, instructions: SERVER_INSTRUCTIONS };
}
