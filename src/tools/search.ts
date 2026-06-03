import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";

interface SearchArgs {
  project: string;
  query: string;
  limit?: number;
  module?: string;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Handle search_context logic (exported for testing). */
export async function handleSearch(args: SearchArgs, deps: ToolDeps): Promise<ToolResult> {
  const { project, query, limit = 10 } = args;

  const vectors = await deps.embeddings.embed([query]);
  if (!vectors) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "Embeddings unavailable — cannot perform semantic search. Start Ollama to enable.",
            code: "EMBEDDINGS_UNAVAILABLE",
          }),
        },
      ],
      isError: true,
    };
  }

  const results = await deps.store.search(project, vectors[0], limit);
  return {
    content: [{ type: "text", text: JSON.stringify({ results }) }],
  };
}

/** Register search_context tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "search_context",
    "Search project knowledge base by semantic similarity",
    {
      project: z.string().describe("Project identifier"),
      query: z.string().describe("Search query text"),
      limit: z.number().optional().describe("Max results (default 10)"),
      module: z.string().optional().describe("Filter by module name"),
    },
    async (args) => handleSearch(args, deps)
  );
}
