import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import type { SymbolHit } from "../graph/store.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Format a SymbolHit as a single line: path:start_line  kind name — signature */
function formatHit(hit: SymbolHit): string {
  return `${hit.path}:${hit.start_line}  ${hit.kind} ${hit.name} — ${hit.signature}`;
}

/** Handle find_symbol logic (exported for testing). */
export async function handleFindSymbol(
  args: { name: string },
  deps: ToolDeps
): Promise<ToolResult> {
  if (!deps.graph) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "graph store not available", code: "GRAPH_UNAVAILABLE" }) }],
      isError: true,
    };
  }

  const hits = deps.graph.findSymbol(args.name);

  if (hits.length === 0) {
    return {
      content: [{ type: "text", text: `No symbol named "${args.name}" found in the index.` }],
    };
  }

  const text = hits.map(formatHit).join("\n");
  return { content: [{ type: "text", text }] };
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
      },
    },
    async (args) => handleFindSymbol(args, deps)
  );
}
