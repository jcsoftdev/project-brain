import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { jsonResult, type ToolResult } from "./format.js";
import { toolAnnotations } from "../constants.js";

interface SearchCodeArgs {
  project: string;
  query: string;
  limit?: number;
}

/** Handle search_code logic (exported for testing). */
export async function handleSearchCode(args: SearchCodeArgs, deps: ToolDeps): Promise<ToolResult> {
  if (!deps.store.ftsSearch) {
    return jsonResult({ error: "store does not support full-text search", code: "FTS_UNSUPPORTED" }, true);
  }
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const results = await deps.store.ftsSearch(args.project, args.query, limit);
  return jsonResult({ results });
}

/** Register search_code tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_code",
    {
      description: "Exact/keyword code search (BM25 full-text over the indexed chunks). Use for identifiers, error strings, exact phrases. Works offline (no embeddings). NOT regex — use grep for regex.",
      inputSchema: {
        project: z.string().describe("Project identifier"),
        query: z.string().describe("Keyword/identifier query"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
      },
      outputSchema: {
        results: z.array(z.object({
          id: z.string(),
          content: z.string(),
          source: z.string(),
          module: z.string(),
          score: z.number(),
        }).passthrough()),
        error: z.string().optional(),
        code: z.string().optional(),
      },
      annotations: toolAnnotations("search_code"),
    },
    async (args) => handleSearchCode(args, deps)
  );
}
