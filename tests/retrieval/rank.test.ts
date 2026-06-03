import { describe, expect, it } from "bun:test";
import { applyThreshold, mmr } from "../../src/retrieval/rank.js";
import type { SearchResult } from "../../src/types.js";

const mk = (id: string, score: number, content: string): SearchResult =>
  ({ id, score, content, source: id + ".ts", module: "src" });

describe("threshold", () => {
  it("drops results below threshold", () => {
    const out = applyThreshold([mk("a", 0.9, "x"), mk("b", 0.1, "y")], 0.5);
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("mmr", () => {
  it("prefers diverse content over near-duplicates", () => {
    const dup = "function foo() { return 1; }";
    const out = mmr([mk("a", 0.95, dup), mk("b", 0.94, dup), mk("c", 0.80, "class Bar {}")], 2, 0.5);
    expect(out.map((r) => r.id)).toEqual(["a", "c"]);
  });
});
