import { describe, it, expect } from "bun:test";
import { buildSourcePredicates } from "../../src/store/batch-delete.js";

describe("buildSourcePredicates", () => {
  it("collapses many sources into a single IN predicate", () => {
    // One lance delete = one transaction = one version manifest. Deleting
    // 58,189 files one at a time produced 78,786 versions and 5GB of
    // manifests; batching is the difference between O(files) and O(batches).
    const out = buildSourcePredicates(["a.ts", "b.ts", "c.ts"], 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("source IN ('a.ts', 'b.ts', 'c.ts')");
  });

  it("splits into batches of the given size", () => {
    const sources = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    expect(buildSourcePredicates(sources, 10)).toHaveLength(3);
  });

  it("escapes single quotes so a path cannot break the predicate", () => {
    expect(buildSourcePredicates(["it's.ts"], 10)[0]).toBe("source IN ('it''s.ts')");
  });

  it("returns nothing for an empty list rather than a predicate matching all", () => {
    // `source IN ()` is either a syntax error or, worse, something that
    // matches unexpectedly. Emitting no predicate is the only safe answer.
    expect(buildSourcePredicates([], 10)).toEqual([]);
  });

  it("treats a non-positive batch size as one batch instead of looping forever", () => {
    expect(buildSourcePredicates(["a.ts", "b.ts"], 0)).toHaveLength(1);
  });
});
