import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { jsonResult, graphUnavailable, type ToolResult } from "./format.js";
import { toolAnnotations } from "../constants.js";

const DEFAULT_MAX_DEPTH = 8;

/** Handle trace_path logic (exported for testing). */
export async function handleTracePath(
  args: { from: string; to: string; maxDepth?: number },
  deps: ToolDeps
): Promise<ToolResult> {
  if (!deps.graph) return graphUnavailable();

  const path = deps.graph.tracePath(args.from, args.to, args.maxDepth ?? DEFAULT_MAX_DEPTH);
  return jsonResult({ path, from: args.from, to: args.to });
}

/** Register trace_path tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "trace_path",
    {
      description:
        "Shortest call path between two symbols (how does A reach B). Returns the ordered caller→callee " +
        "chain, including both endpoints, or an empty path when B is unreachable from A within maxDepth. " +
        "Use for 'how does A end up calling B' questions — structural analysis, faster and more precise " +
        "than search_context. Complements find_callers/find_callees (one hop) and impact (blast radius).",
      inputSchema: {
        from: z.string().describe("Exact name of the starting (caller-side) symbol"),
        to: z.string().describe("Exact name of the target (callee-side) symbol"),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum traversal depth (default 8, max 20)"),
      },
      outputSchema: {
        path: z.array(z.object({
          name: z.string(),
          kind: z.string(),
          signature: z.string(),
          path: z.string(),
          start_line: z.number(),
          end_line: z.number(),
        })),
        from: z.string(),
        to: z.string(),
        error: z.string().optional(),
        code: z.string().optional(),
      },
      annotations: toolAnnotations("trace_path"),
    },
    async (args) => handleTracePath(args, deps)
  );
}
