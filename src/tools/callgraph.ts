import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { formatHits, graphUnavailable, type ToolResult } from "./format.js";
import { toolAnnotations } from "../constants.js";

/** Handle find_callers logic (exported for testing). */
export async function handleFindCallers(
  args: { name: string },
  deps: ToolDeps
): Promise<ToolResult> {
  if (!deps.graph) return graphUnavailable();

  const hits = deps.graph.findCallers(args.name);

  if (hits.length === 0) {
    return {
      content: [{ type: "text", text: `No callers of "${args.name}" found in the index.` }],
      structuredContent: { hits: [] },
    };
  }

  return { content: [{ type: "text", text: formatHits(hits) }], structuredContent: { hits } };
}

/** Handle find_callees logic (exported for testing). */
export async function handleFindCallees(
  args: { name: string },
  deps: ToolDeps
): Promise<ToolResult> {
  if (!deps.graph) return graphUnavailable();

  const hits = deps.graph.findCallees(args.name);

  if (hits.length === 0) {
    return {
      content: [{ type: "text", text: `No callees of "${args.name}" found in the index.` }],
      structuredContent: { hits: [] },
    };
  }

  return { content: [{ type: "text", text: formatHits(hits) }], structuredContent: { hits } };
}

/** Register find_callers and find_callees tools with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "find_callers",
    {
      description:
        "Find all symbols that call (depend on) the named symbol. Returns every caller: file path, line, kind, and signature. " +
        "Use for 'what calls X' or 'who uses X' questions — faster and more precise than search_context for call-graph lookups. " +
        "Complements find_callees (what X calls), find_symbol (where X is defined), and search_context (semantic).",
      inputSchema: {
        name: z.string().describe("Exact symbol name to find callers of (case-sensitive)"),
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
      },
      annotations: toolAnnotations("find_callers"),
    },
    async (args) => handleFindCallers(args, deps)
  );

  server.registerTool(
    "find_callees",
    {
      description:
        "Find all symbols that the named symbol calls (depends on). Returns every callee: file path, line, kind, and signature. " +
        "Use for 'what does X call' or 'what does X depend on' questions — faster and more precise than search_context for call-graph lookups. " +
        "Complements find_callers (who calls X), find_symbol (where X is defined), and search_context (semantic).",
      inputSchema: {
        name: z.string().describe("Exact symbol name to find callees of (case-sensitive)"),
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
      },
      annotations: toolAnnotations("find_callees"),
    },
    async (args) => handleFindCallees(args, deps)
  );
}
