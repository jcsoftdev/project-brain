import { rankOf, recallAtK, meanReciprocalRank, type Rank } from "./metrics.js";

export interface BenchQuery {
  /** The natural-language question, exactly as a user would ask it. */
  query: string;
  /** Repo-relative path of the source that SHOULD be retrieved. */
  expect: string;
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
    if (typeof entry.query !== "string" || typeof entry.expect !== "string") {
      throw new Error(`bench: line ${i + 1} needs both "query" and "expect" strings`);
    }
    out.push({ query: entry.query, expect: entry.expect });
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
    results.push({ ...q, rank: rankOf(sources, q.expect) });
  }

  const ranks = results.map((r) => r.rank);
  const recall: Record<number, number> = {};
  for (const k of cutoffs) recall[k] = recallAtK(ranks, k);

  return { results, recall, mrr: meanReciprocalRank(ranks), errors };
}
