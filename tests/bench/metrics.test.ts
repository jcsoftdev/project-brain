import { describe, it, expect } from "bun:test";
import { rankOf, rankOfAny, recallAtK, meanReciprocalRank } from "../../src/bench/metrics.js";

describe("rankOf", () => {
  it("returns the 1-based position of the first matching result", () => {
    const results = ["src/a.ts", "src/b.ts", "src/target.ts"];
    expect(rankOf(results, "src/target.ts")).toBe(3);
  });

  it("matches on path suffix so ground truth can stay repo-relative", () => {
    const results = ["/abs/repo/src/target.ts"];
    expect(rankOf(results, "src/target.ts")).toBe(1);
  });

  it("returns null when nothing matches", () => {
    expect(rankOf(["src/a.ts"], "src/missing.ts")).toBeNull();
  });

  it("does not match a partial path segment", () => {
    // "src/a.ts" must not satisfy an expectation of "b/a.ts".
    expect(rankOf(["src/a.ts"], "b/a.ts")).toBeNull();
  });
});

describe("rankOfAny", () => {
  it("behaves like rankOf for a single expected string", () => {
    expect(rankOfAny(["src/a.ts", "src/target.ts"], "src/target.ts")).toBe(2);
  });

  it("returns the best (lowest) rank among several expected files", () => {
    const results = ["src/z.ts", "src/b.ts", "src/a.ts"];
    // "src/a.ts" ranks 3rd, "src/b.ts" ranks 2nd — the query hit as soon as
    // ANY gold file appeared, so the score reflects the earlier one.
    expect(rankOfAny(results, ["src/a.ts", "src/b.ts"])).toBe(2);
  });

  it("returns null when none of the expected files appear", () => {
    expect(rankOfAny(["src/z.ts"], ["src/a.ts", "src/b.ts"])).toBeNull();
  });

  it("returns null for an empty expected list", () => {
    expect(rankOfAny(["src/a.ts"], [])).toBeNull();
  });
});

describe("recallAtK", () => {
  it("counts a query as hit only when its rank is within k", () => {
    expect(recallAtK([1, 3, null], 1)).toBeCloseTo(1 / 3, 10);
    expect(recallAtK([1, 3, null], 5)).toBeCloseTo(2 / 3, 10);
  });

  it("is 0 when nothing was found", () => {
    expect(recallAtK([null, null], 10)).toBe(0);
  });

  it("is 0 for an empty query set rather than NaN", () => {
    // A divide-by-zero here would print "NaN%" and look like a broken index
    // instead of an empty benchmark.
    expect(recallAtK([], 10)).toBe(0);
  });
});

describe("meanReciprocalRank", () => {
  it("averages 1/rank, treating a miss as 0", () => {
    // 1/1 + 1/2 + 0 = 1.5, over 3 queries.
    expect(meanReciprocalRank([1, 2, null])).toBeCloseTo(0.5, 10);
  });

  it("is 0 for an empty query set", () => {
    expect(meanReciprocalRank([])).toBe(0);
  });
});
