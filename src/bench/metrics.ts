/**
 * Retrieval metrics for comparing index configurations (embedding model,
 * dimension, chunking) against a fixed set of queries.
 *
 * The point of measuring locally is that published leaderboards score a
 * different corpus and a different task: MTEB-Code is not your repository, and
 * a 1.4% delta on someone else's benchmark says nothing about whether YOUR
 * queries still surface the right file.
 */

/** A rank is 1-based; null means the expected source never appeared. */
export type Rank = number | null;

/**
 * Position of the first result whose source satisfies `expected`.
 *
 * Matching is on path SEGMENTS from the right, so ground truth can be written
 * repo-relative ("src/target.ts") and still match an absolute stored source.
 * Segment-awareness is what stops "src/a.ts" from satisfying "b/a.ts".
 */
export function rankOf(sources: string[], expected: string): Rank {
  const want = expected.split("/").filter(Boolean);

  for (let i = 0; i < sources.length; i++) {
    const got = sources[i]!.split("/").filter(Boolean);
    if (got.length < want.length) continue;
    const tail = got.slice(got.length - want.length);
    if (tail.every((seg, j) => seg === want[j])) return i + 1;
  }
  return null;
}

/** Fraction of queries whose expected source appeared within the top k. */
export function recallAtK(ranks: Rank[], k: number): number {
  if (ranks.length === 0) return 0;
  const hits = ranks.filter((r) => r !== null && r <= k).length;
  return hits / ranks.length;
}

/**
 * Mean of 1/rank across queries, misses counted as 0.
 *
 * Complements recall: recall@10 treats rank 1 and rank 10 alike, while MRR
 * rewards putting the right answer first — which is what actually matters when
 * a hook injects only the top few results into a prompt.
 */
export function meanReciprocalRank(ranks: Rank[]): number {
  if (ranks.length === 0) return 0;
  const total = ranks.reduce<number>((sum, r) => sum + (r === null ? 0 : 1 / r), 0);
  return total / ranks.length;
}
