import { describe, it, expect } from "bun:test";
import { parseQueries, runBench } from "../../src/bench/run.js";

describe("parseQueries", () => {
  it("reads one JSON object per line", () => {
    const text = [
      '{"query":"how is auth checked","expect":"src/auth.ts"}',
      '{"query":"chunk splitting","expect":"src/indexer/chunk.ts"}',
    ].join("\n");

    expect(parseQueries(text)).toEqual([
      { query: "how is auth checked", expect: "src/auth.ts" },
      { query: "chunk splitting", expect: "src/indexer/chunk.ts" },
    ]);
  });

  it("skips blank lines and comments", () => {
    const text = ['# ground truth', "", '{"query":"a","expect":"b.ts"}'].join("\n");
    expect(parseQueries(text)).toHaveLength(1);
  });

  it("reports the line number of a malformed entry instead of dying silently", () => {
    const text = ['{"query":"a","expect":"b.ts"}', "{not json"].join("\n");
    expect(() => parseQueries(text)).toThrow(/line 2/);
  });

  it("rejects an entry missing query or expect", () => {
    expect(() => parseQueries('{"query":"a"}')).toThrow(/line 1/);
  });
});

describe("runBench", () => {
  const queries = [
    { query: "q1", expect: "src/a.ts" },
    { query: "q2", expect: "src/b.ts" },
    { query: "q3", expect: "src/missing.ts" },
  ];

  // q1 -> rank 1, q2 -> rank 2, q3 -> absent
  const search = async (q: string) => {
    if (q === "q1") return ["src/a.ts", "src/z.ts"];
    if (q === "q2") return ["src/z.ts", "src/b.ts"];
    return ["src/z.ts"];
  };

  it("reports a rank per query", async () => {
    const report = await runBench(search, queries);
    expect(report.results.map((r) => r.rank)).toEqual([1, 2, null]);
  });

  it("computes recall at each requested cutoff", async () => {
    const report = await runBench(search, queries, { cutoffs: [1, 5] });
    expect(report.recall[1]).toBeCloseTo(1 / 3, 10);
    expect(report.recall[5]).toBeCloseTo(2 / 3, 10);
  });

  it("computes MRR across the set", async () => {
    const report = await runBench(search, queries);
    // 1/1 + 1/2 + 0 = 1.5 over 3
    expect(report.mrr).toBeCloseTo(0.5, 10);
  });

  it("counts a query whose search throws as a miss, not a crash", async () => {
    // One bad query must not discard the whole run's measurements.
    const flaky = async (q: string) => {
      if (q === "q2") throw new Error("embedding unavailable");
      return search(q);
    };
    const report = await runBench(flaky, queries);
    expect(report.results.map((r) => r.rank)).toEqual([1, null, null]);
    expect(report.errors).toBe(1);
  });
});
