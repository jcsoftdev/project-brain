import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps, GraphDeps } from "../types.js";
import { formatHits, type ToolResult } from "./format.js";
import { toolAnnotations } from "../constants.js";
import { PROJECT_ARG, SCOPE_OUTPUT, resolveGraphScope } from "./graph-scope.js";

/** Handle find_callers logic (exported for testing). */
export async function handleFindCallers(
  args: { name: string; project?: string },
  deps: GraphDeps
): Promise<ToolResult> {
  const scope = await resolveGraphScope(deps, args.project);
  if (!scope.ok) return scope.result;

  const hits = scope.graph.findCallers(args.name);

  if (hits.length === 0) {
    return {
      content: [{ type: "text", text: `No callers of "${args.name}" found in the ${scope.project} index.` }],
      structuredContent: { hits: [], project: scope.project },
    };
  }

  return {
    content: [{ type: "text", text: formatHits(hits) }],
    structuredContent: { hits, project: scope.project },
  };
}

/** Handle find_callees logic (exported for testing). */
export async function handleFindCallees(
  args: { name: string; project?: string },
  deps: GraphDeps
): Promise<ToolResult> {
  const scope = await resolveGraphScope(deps, args.project);
  if (!scope.ok) return scope.result;

  const hits = scope.graph.findCallees(args.name);

  if (hits.length === 0) {
    return {
      content: [{ type: "text", text: `No callees of "${args.name}" found in the ${scope.project} index.` }],
      structuredContent: { hits: [], project: scope.project },
    };
  }

  return {
    content: [{ type: "text", text: formatHits(hits) }],
    structuredContent: { hits, project: scope.project },
  };
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
      annotations: toolAnnotations("find_callees"),
    },
    async (args) => handleFindCallees(args, deps)
  );
}
