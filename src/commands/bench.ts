import { readFile } from "node:fs/promises";
import { DB_PATH, OLLAMA_HOST } from "../constants.js";
import { LanceDbStore } from "../store/lancedb.js";
import { readTableMeta } from "../store/meta.js";
import { createEmbeddingClient } from "../embeddings/factory.js";
import { parseQueries, runBench, type BenchReport } from "../bench/run.js";

export interface BenchCommandOptions {
  project: string;
  /** Where the LanceDB tables live. Injected in tests; defaults to DB_PATH. */
  dbPath?: string;
  /** Path to a JSONL ground-truth file: {"query": "...", "expect": "src/x.ts"}. */
  queriesPath: string;
  cutoffs?: number[];
}

/**
 * Measure retrieval quality for one indexed configuration.
 *
 * Exists because published leaderboards score a different corpus and a
 * different task. MTEB-Code is not your repository, and a percent-or-two delta
 * on someone else's benchmark cannot tell you whether YOUR queries still
 * surface the right file after changing model, dimension or chunking.
 *
 * Deliberately measures hybridSearch + score threshold, NOT the full
 * search_context pipeline: MMR re-orders for diversity and the token budget
 * truncates, and both are configuration-independent post-processing. Including
 * them would add noise to precisely the comparison this exists to make.
 */
export async function benchCommand(
  options: BenchCommandOptions
): Promise<BenchReport> {
  const queries = parseQueries(await readFile(options.queriesPath, "utf-8"));
  if (queries.length === 0) {
    console.log("No queries to run — the ground-truth file is empty.");
    return { results: [], recall: {}, mrr: 0, errors: 0 };
  }

  const dbPath = options.dbPath ?? DB_PATH;
  const store = new LanceDbStore(dbPath);
  const meta = await readTableMeta(dbPath, options.project);
  const embeddings = await createEmbeddingClient(meta?.model, {
    host: OLLAMA_HOST,
    autoPull: false,
  });

  const report = await runBench(
    async (query, topK) => {
      const vectors = await embeddings.embed([query]);
      if (!vectors?.[0]) throw new Error("embedding unavailable");
      const hits = await store.hybridSearch(options.project, vectors[0], query, topK);
      return hits.map((h) => h.source);
    },
    queries,
    { cutoffs: options.cutoffs }
  );

  // The configuration is part of the measurement — a recall number without the
  // model and dimension that produced it cannot be compared to anything.
  console.log(`project     ${options.project}`);
  console.log(`model       ${meta?.model ?? "(unknown)"} @ ${meta?.dim ?? "?"} dims`);
  console.log(`queries     ${queries.length}${report.errors ? ` (${report.errors} errored)` : ""}`);
  for (const k of Object.keys(report.recall).map(Number).sort((a, b) => a - b)) {
    console.log(`recall@${String(k).padEnd(4)}${(report.recall[k]! * 100).toFixed(1)}%`);
  }
  console.log(`MRR         ${report.mrr.toFixed(4)}`);

  const misses = report.results.filter((r) => r.rank === null);
  if (misses.length > 0) {
    console.log(`\nNot retrieved at all (${misses.length}):`);
    for (const m of misses) console.log(`  ${m.expect}  <-  "${m.query}"`);
  }

  return report;
}
