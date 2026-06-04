import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { applyThreshold, mmr } from "../retrieval/rank.js";
import { fillBudget } from "../retrieval/budget.js";
import { SCORE_THRESHOLD, MMR_LAMBDA, SEARCH_TOKEN_BUDGET, SNIPPET_MAX_LINES, HARDNESS } from "../constants.js";

interface SearchArgs {
  project: string;
  query: string;
  limit?: number;
  module?: string;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Handle search_context logic (exported for testing). */
export async function handleSearch(args: SearchArgs, deps: ToolDeps): Promise<ToolResult> {
  const { project, query, limit = 10 } = args;

  const emb = deps.embeddingsFor ? await deps.embeddingsFor(project) : deps.embeddings;

  const vectors = await emb.embed([query]);
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

  if (HARDNESS) {
    await deps.store.assertDim(project, emb.dim);
  }

  const fused = await deps.store.hybridSearch(project, vectors[0], query, Math.max(limit * 3, 20));
  const kept = applyThreshold(fused, SCORE_THRESHOLD);
  const diverse = mmr(kept, limit, MMR_LAMBDA);
  const results = fillBudget(diverse, SEARCH_TOKEN_BUDGET, SNIPPET_MAX_LINES);
  return {
    content: [{ type: "text", text: JSON.stringify({ results }) }],
  };
}

/** Register search_context tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_context",
    {
      description: "Semantic/conceptual search of THIS project (code + docs). Use for cross-file or fuzzy context when you may not know the exact symbol name (e.g. 'how does auth work', 'where is X handled'). Returns ranked snippets each with a chunk_id; follow up with expand_context for full bodies. For exact symbol/caller/AST lookups, prefer a structural tool.",
      inputSchema: {
        project: z.string().describe("Project identifier"),
        query: z.string().describe("Search query text"),
        limit: z.number().optional().describe("Max results (default 10)"),
        module: z.string().optional().describe("Filter by module name"),
      },
    },
    async (args) => handleSearch(args, deps)
  );
}
