import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps, GraphDeps } from "../types.js";
import { formatHits, type ToolResult } from "./format.js";
import { toolAnnotations } from "../constants.js";
import { PROJECT_ARG, SCOPE_OUTPUT, resolveGraphScope } from "./graph-scope.js";

/** Handle find_symbol logic (exported for testing). */
export async function handleFindSymbol(
  args: { name: string; project?: string },
  deps: GraphDeps
): Promise<ToolResult> {
  const scope = await resolveGraphScope(deps, args.project);
  if (!scope.ok) return scope.result;

  const hits = scope.graph.findSymbol(args.name);

  if (hits.length === 0) {
    return {
      content: [{ type: "text", text: `No symbol named "${args.name}" found in the ${scope.project} index.` }],
      structuredContent: { hits: [], project: scope.project },
    };
  }

  return {
    content: [{ type: "text", text: formatHits(hits) }],
    structuredContent: { hits, project: scope.project },
  };
}

/** Register find_symbol tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "find_symbol",
    {
      description:
        "Exact symbol lookup by name. Returns every definition of the named symbol: file path, line range, kind, and signature. " +
        "Use this for 'where is X defined' questions — it is faster and more precise than search_context for exact names. " +
        "Complements search_context (semantic) and expand_context (full body).",
      inputSchema: {
        name: z.string().describe("Exact symbol name to look up (case-sensitive)"),
        project: PROJECT_ARG,
      },
      outputSchema: {
        hits: z.array(z.object({
          name: z.string(),
          kind: z.string(),
          signature: z.string(),
          path: z.string(),
          start_line: z.number(),
          end_line: z.number(),
        })),
        ...SCOPE_OUTPUT,
      },
      annotations: toolAnnotations("find_symbol"),
    },
    async (args) => handleFindSymbol(args, deps)
  );
}
