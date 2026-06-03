import type { SearchResult } from "../types.js";

export interface BudgetedResult {
  chunk_id: string; source: string; symbol?: string;
  signature?: string; snippet: string; score: number;
  start_line?: number; end_line?: number;
}

/** ~4 chars per token heuristic. */
export function estimateTokens(s: string): number { return Math.ceil(s.length / 4); }

export function buildSnippet(content: string, maxLines: number): string {
  return content.split("\n").slice(0, maxLines).join("\n");
}

export function fillBudget(results: SearchResult[], tokenBudget: number, maxLines = 5): BudgetedResult[] {
  const out: BudgetedResult[] = [];
  let spent = 0;
  for (const r of results) {
    const snippet = buildSnippet(r.content, maxLines);
    const cost = estimateTokens(snippet) + estimateTokens(r.signature ?? "") + 10;
    if (spent + cost > tokenBudget) continue; // skip oversized, keep filling with cheaper ones
    spent += cost;
    out.push({
      chunk_id: r.id, source: r.source, symbol: r.symbol_name,
      signature: r.signature, snippet, score: Number(r.score.toFixed(3)),
      start_line: r.start_line, end_line: r.end_line,
    });
  }
  return out;
}
