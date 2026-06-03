import { describe, expect, it } from "bun:test";
import { buildSnippet, fillBudget } from "../../src/retrieval/budget.js";
import type { SearchResult } from "../../src/types.js";

const mk = (id: string, content: string): SearchResult =>
  ({ id, score: 0.9, content, source: id + ".ts", module: "src",
     symbol_name: id, signature: `function ${id}()` });

describe("buildSnippet", () => {
  it("keeps signature + first N lines", () => {
    const snip = buildSnippet("function f() {\n a\n b\n c\n d\n e\n}", 3);
    expect(snip.split("\n").length).toBeLessThanOrEqual(3);
  });
});

describe("fillBudget", () => {
  it("stops at the chunk that would exceed the token budget", () => {
    const big = "x ".repeat(500);
    const out = fillBudget([mk("a", "small"), mk("b", big), mk("c", "small")], 50);
    expect(out.map((r) => r.chunk_id)).toEqual(["a", "c"]);
  });
});
