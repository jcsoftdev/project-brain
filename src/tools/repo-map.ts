import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { jsonResult, graphUnavailable, type ToolResult } from "./format.js";
import { toolAnnotations } from "../constants.js";
import { estimateTokens } from "../retrieval/budget.js";
import type { RankedSymbol } from "../graph/store.js";

const DEFAULT_TOKEN_BUDGET = 1000;
const MIN_TOKEN_BUDGET = 100;
const MAX_TOKEN_BUDGET = 8000;

/** Handle repo_map logic (exported for testing). */
export async function handleRepoMap(
  args: { token_budget?: number; focus?: string[] },
  deps: ToolDeps
): Promise<ToolResult> {
  if (!deps.graph) return graphUnavailable();

  const tokenBudget = Math.min(Math.max(args.token_budget ?? DEFAULT_TOKEN_BUDGET, MIN_TOKEN_BUDGET), MAX_TOKEN_BUDGET);
  const ranked = deps.graph.pageRank({ focus: args.focus });

  // Group by file, ordered by the SUM of each file's symbol ranks (descending).
  const byFile = new Map<string, RankedSymbol[]>();
  for (const sym of ranked) {
    const list = byFile.get(sym.file);
    if (list) list.push(sym);
    else byFile.set(sym.file, [sym]);
  }
  const files = [...byFile.entries()]
    .map(([file, syms]) => ({ file, syms, total: syms.reduce((sum, s) => sum + s.rank, 0) }))
    .sort((a, b) => b.total - a.total);
  for (const f of files) f.syms.sort((a, b) => b.rank - a.rank);

  const lines: string[] = [];
  let spent = 0;
  let truncated = false;
  let includedFiles = 0;
  let includedSymbols = 0;

  outer: for (const f of files) {
    const headerCost = estimateTokens(f.file);
    if (spent + headerCost > tokenBudget) { truncated = true; break; }

    const symbolLines: string[] = [];
    let fileSpent = headerCost;
    let fileIncludedSymbols = 0;
    for (const sym of f.syms) {
      const line = `  ${sym.kind} ${sym.name} — ${sym.signature}`;
      const cost = estimateTokens(line);
      if (spent + fileSpent + cost > tokenBudget) {
        // Only count truncation if there was more content after this cutoff.
        if (fileIncludedSymbols < f.syms.length) truncated = true;
        break;
      }
      symbolLines.push(line);
      fileSpent += cost;
      fileIncludedSymbols++;
    }

    if (fileIncludedSymbols === 0) {
      // Nothing from this file fit — stop entirely (greedy, file-rank order).
      truncated = true;
      break outer;
    }

    lines.push(f.file, ...symbolLines);
    spent += fileSpent;
    includedFiles++;
    includedSymbols += fileIncludedSymbols;

    if (fileIncludedSymbols < f.syms.length) {
      truncated = true;
      break outer;
    }
  }
  if (!truncated && includedFiles < files.length) truncated = true;

  return jsonResult({
    map: lines.join("\n"),
    files: includedFiles,
    symbols: includedSymbols,
    truncated,
  });
}

/** Register repo_map tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "repo_map",
    {
      description:
        "Token-budgeted overview of the most important symbols in the codebase, ranked by PageRank over " +
        "the call graph. Use for 'where do I start reading' / repo orientation / architectural overview " +
        "questions. Optionally focus the ranking on specific symbols for a targeted map.",
      inputSchema: {
        token_budget: z
          .number()
          .int()
          .min(MIN_TOKEN_BUDGET)
          .max(MAX_TOKEN_BUDGET)
          .optional()
          .describe(`Approximate token budget for the rendered map (default ${DEFAULT_TOKEN_BUDGET}, range ${MIN_TOKEN_BUDGET}-${MAX_TOKEN_BUDGET})`),
        focus: z
          .array(z.string())
          .optional()
          .describe("Optional symbol names to focus the PageRank on (personalized ranking) — highlights symbols reachable from these"),
      },
      outputSchema: {
        map: z.string(),
        files: z.number(),
        symbols: z.number(),
        truncated: z.boolean(),
        error: z.string().optional(),
        code: z.string().optional(),
      },
      annotations: toolAnnotations("repo_map"),
    },
    async (args) => handleRepoMap(args, deps)
  );
}
