import type { SearchResult } from "../types.js";
import type { Reranker } from "./jev.js";

/**
 * Rerank a retrieved pool with Jev BEFORE threshold/MMR run, so those steps
 * operate on the reranked scores rather than the original vector/BM25 ones.
 *
 * On a missing reranker, an empty pool, or a failed rerank (null — timeout,
 * non-2xx, malformed body, missing answer), the pool is returned exactly as
 * it was: never partially reordered.
 */
export async function rerankPool(
  pool: SearchResult[],
  query: string,
  reranker?: Reranker
): Promise<SearchResult[]> {
  if (!reranker || pool.length === 0) return pool;

  const candidates = pool.map((r) => ({
    file: r.source,
    ...(r.symbol_name ? { symbol: r.symbol_name } : {}),
    content: r.content,
  }));

  const scores = await reranker.rerank(query, candidates);
  if (!scores || scores.length !== pool.length) return pool;

  return pool
    .map((r, i) => ({ ...r, score: scores[i] }))
    .sort((a, b) => b.score - a.score);
}
