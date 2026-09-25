import { rankOfAny, recallAtK, meanReciprocalRank, type Rank } from "./metrics.js";

export interface BenchQuery {
  /** The natural-language question, exactly as a user would ask it. */
  query: string;
  /**
   * Repo-relative path(s) of the source(s) that SHOULD be retrieved.
   *
   * A single string for the common case (one query, one gold file) and an
   * array when several files legitimately answer the same query — a commit
   * that touched more than one file, for instance. A hit is ANY of them
   * appearing in the results; the rank used for MRR is the best of the two.
   */
  expect: string | string[];
}

export interface BenchResult extends BenchQuery {
  rank: Rank;
}

export interface BenchReport {
  results: BenchResult[];
  /** cutoff k -> fraction of queries whose expected source ranked within k. */
  recall: Record<number, number>;
  mrr: number;
  /** Queries whose search threw; counted as misses. */
  errors: number;
}

/** How the caller retrieves: query text -> ranked source paths. */
export type SearchFn = (query: string, topK: number) => Promise<string[]>;

const DEFAULT_CUTOFFS = [1, 5, 10];

/**
 * Parse a ground-truth file: one JSON object per line, `#` comments allowed.
 *
 * JSONL rather than one big array so a hand-written file stays diffable and a
 * single bad entry names its own line instead of invalidating the document.
 */
export function parseQueries(text: string): BenchQuery[] {
  const out: BenchQuery[] = [];

  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`bench: malformed JSON on line ${i + 1}: ${line.slice(0, 80)}`);
    }

    const entry = parsed as Partial<BenchQuery>;
    const expectOk =
      typeof entry.expect === "string" ||
      (Array.isArray(entry.expect) &&
        entry.expect.length > 0 &&
        entry.expect.every((e) => typeof e === "string"));
    if (typeof entry.query !== "string" || !expectOk) {
      throw new Error(
        `bench: line ${i + 1} needs "query" (string) and "expect" (a non-empty string or string[])`
      );
    }
    out.push({ query: entry.query, expect: entry.expect as string | string[] });
  });

  return out;
}

/**
 * Run every query and score where the expected source landed.
 *
 * A query whose search throws is recorded as a miss rather than aborting the
 * run: comparing two configurations is only useful if both complete, and a
 * partial run with a visible error count is more informative than no run.
 */
export async function runBench(
  search: SearchFn,
  queries: BenchQuery[],
  opts: { cutoffs?: number[]; topK?: number } = {}
): Promise<BenchReport> {
  const cutoffs = opts.cutoffs ?? DEFAULT_CUTOFFS;
  const topK = opts.topK ?? Math.max(...cutoffs, 10);

  const results: BenchResult[] = [];
  let errors = 0;

  for (const q of queries) {
    let sources: string[] = [];
    try {
      sources = await search(q.query, topK);
    } catch {
      errors++;
    }
    results.push({ ...q, rank: rankOfAny(sources, q.expect) });
  }

  const ranks = results.map((r) => r.rank);
  const recall: Record<number, number> = {};
  for (const k of cutoffs) recall[k] = recallAtK(ranks, k);

  return { results, recall, mrr: meanReciprocalRank(ranks), errors };
}
