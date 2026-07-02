import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { formatHits, graphUnavailable, type ToolResult } from "./format.js";
import { toolAnnotations } from "../constants.js";

const DEFAULT_MAX_DEPTH = 6;

/** Handle impact logic (exported for testing). */
export async function handleImpact(
  args: { name: string; maxDepth?: number },
  deps: ToolDeps
): Promise<ToolResult> {
  if (!deps.graph) return graphUnavailable();

  const maxDepth = args.maxDepth ?? DEFAULT_MAX_DEPTH;
  const hits = deps.graph.impact(args.name, maxDepth);

  if (hits.length === 0) {
    return {
      content: [{ type: "text", text: `No transitive callers of "${args.name}" found in the index.` }],
    };
  }

  return { content: [{ type: "text", text: formatHits(hits) }] };
}

/** Register impact tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "impact",
    {
      description:
        "Blast-radius analysis: returns every symbol transitively affected if the named symbol changes. " +
        "Walks the reverse call graph up to maxDepth hops to find all direct and indirect callers. " +
        "Use for 'what would break if I change X' or 'what is the blast radius of X' questions — " +
        "structural analysis, faster and more precise than search_context. " +
        "Complements find_callers (direct callers only), find_symbol (definition), and search_context (semantic).",
      inputSchema: {
        name: z.string().describe("Exact symbol name to analyse (case-sensitive)"),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum traversal depth (default 6, max 20)"),
      },
      annotations: toolAnnotations("impact"),
    },
    async (args) => handleImpact(args, deps)
  );
}
