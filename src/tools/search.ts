import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { applyThreshold, mmr } from "../retrieval/rank.js";
import { fillBudget } from "../retrieval/budget.js";
import { expandQuery } from "../retrieval/query-expand.js";
import { SCORE_THRESHOLD, MMR_LAMBDA, SEARCH_TOKEN_BUDGET, SNIPPET_MAX_LINES, HARDNESS, toolAnnotations } from "../constants.js";
import { jsonResult, type ToolResult } from "./format.js";
import { QueryEmbedCache } from "../embeddings/query-cache.js";

const LEXICAL_DEGRADED_NOTE =
  "Embeddings unavailable — showing keyword (BM25) results. Conceptual matches may be missed; start Ollama for full semantic search.";

/**
 * Module-level singleton: the serve process is long-lived, so identical
 * repeat queries within its lifetime should not pay Ollama's ~900ms embed
 * round-trip twice. Per-call instances would never hit.
 */
const queryCache = new QueryEmbedCache();

interface SearchArgs {
  project: string;
  query: string;
  limit?: number;
  module?: string;
}

/** Handle search_context logic (exported for testing). */
export async function handleSearch(args: SearchArgs, deps: ToolDeps): Promise<ToolResult> {
  const { project, query } = args;
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);

  const emb = deps.embeddingsFor ? await deps.embeddingsFor(project) : deps.embeddings;

  const modelKey = emb.model ?? "";
  const cached = queryCache.get(modelKey, query);
  const vectors = cached ? [cached] : await emb.embed([query]);
  if (vectors && !cached) queryCache.set(modelKey, query, vectors[0]);
  if (!vectors) {
    // Lexical floor: no Ollama / embeddings available. Degrade to BM25 with
    // code-aware query expansion instead of hard-failing — same threshold/
    // budget post-processing as the vector path, minus MMR (no vectors to
    // diversify against).
    const ftsResults = deps.store.ftsSearch
      ? await deps.store.ftsSearch(project, expandQuery(query), Math.max(limit * 3, 20))
      : [];
    const kept = applyThreshold(ftsResults, SCORE_THRESHOLD);
    // mmr diversifies via lexical Jaccard on `content` and needs no vector
    // field, so it runs unmodified on FTS results — mirrors the vector
    // path's cap-and-diversify step instead of only capping by token budget.
    const diverse = mmr(kept, limit, MMR_LAMBDA);
    const results = fillBudget(diverse, SEARCH_TOKEN_BUDGET, SNIPPET_MAX_LINES);
    return jsonResult({
      results,
      degraded: true,
      mode: "lexical",
      note: LEXICAL_DEGRADED_NOTE,
    });
  }

  if (HARDNESS) {
    await deps.store.assertDim(project, emb.dim);
  }

  const fused = await deps.store.hybridSearch(project, vectors[0], query, Math.max(limit * 3, 20));
  const kept = applyThreshold(fused, SCORE_THRESHOLD);
  const diverse = mmr(kept, limit, MMR_LAMBDA);
  const results = fillBudget(diverse, SEARCH_TOKEN_BUDGET, SNIPPET_MAX_LINES);
  return jsonResult({ results });
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
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
        module: z.string().optional().describe("Filter by module name"),
      },
      outputSchema: {
        results: z.array(z.object({
          chunk_id: z.string(),
          source: z.string(),
          symbol: z.string().optional(),
          signature: z.string().optional(),
          snippet: z.string(),
          score: z.number(),
          start_line: z.number().optional(),
          end_line: z.number().optional(),
        }).passthrough()),
        degraded: z.boolean().optional(),
        mode: z.literal("lexical").optional(),
        note: z.string().optional(),
      },
      annotations: toolAnnotations("search_context"),
    },
    async (args) => handleSearch(args, deps)
  );
}
