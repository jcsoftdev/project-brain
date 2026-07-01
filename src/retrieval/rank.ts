import type { SearchResult } from "../types.js";

export function applyThreshold(results: SearchResult[], min: number): SearchResult[] {
  return results.filter((r) => r.score >= min);
}

function tokenSet(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/** Maximal Marginal Relevance using lexical similarity as the diversity penalty. */
export function mmr(results: SearchResult[], k: number, lambda: number): SearchResult[] {
  const pool = [...results];
  const sets = new Map(pool.map((r) => [r.id, tokenSet(r.content)]));
  // Running max similarity of each remaining candidate against the picked set so
  // far — updated incrementally against only the newest pick, instead of
  // recomputing against every prior pick on every round.
  const maxSim = new Map(pool.map((r) => [r.id, 0]));
  const picked: SearchResult[] = [];
  while (picked.length < k && pool.length > 0) {
    let best = -Infinity, bestIdx = 0;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      const mmrScore = lambda * cand.score - (1 - lambda) * maxSim.get(cand.id)!;
      if (mmrScore > best) { best = mmrScore; bestIdx = i; }
    }
    const chosen = pool.splice(bestIdx, 1)[0];
    picked.push(chosen);
    for (const cand of pool) {
      const sim = jaccard(sets.get(cand.id)!, sets.get(chosen.id)!);
      if (sim > maxSim.get(cand.id)!) maxSim.set(cand.id, sim);
    }
  }
  return picked;
}
