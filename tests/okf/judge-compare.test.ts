import { describe, it, expect } from "bun:test";
import { compareJudges, formatCompareReport } from "../../src/okf/judge.js";
import type { StaleFinding } from "../../src/okf/audit.js";
import type { StaleJudge } from "../../src/okf/judge.js";

function fakeJudge(byConcept: Record<string, "holds" | "outdated" | "unclear">): StaleJudge {
  return {
    judge: async (input) => {
      // The concept is threaded through conceptBody by the test's conceptBody() fn below.
      const concept = input.conceptBody;
      return { verdict: byConcept[concept] ?? "unclear", reason: `said ${byConcept[concept]}` };
    },
  };
}

function finding(concept: string): StaleFinding {
  return {
    concept,
    resource: "../src/a.ts",
    path: "src/a.ts",
    attestedAt: "2026-01-01T00:00:00Z",
    changedAt: "2026-06-01T00:00:00Z",
    reason: "code-changed",
    range: null,
  };
}

describe("compareJudges", () => {
  it("pairs each eligible finding's primary and compare verdicts", async () => {
    const findings = [finding("a.md"), finding("b.md")];

    const results = await compareJudges(findings, {
      primary: fakeJudge({ "a.md": "holds", "b.md": "outdated" }),
      compare: fakeJudge({ "a.md": "holds", "b.md": "unclear" }),
      diff: () => "some diff",
      conceptBody: (c) => c,
    });

    expect(results).toHaveLength(2);
    const a = results.find((r) => r.concept === "a.md")!;
    const b = results.find((r) => r.concept === "b.md")!;
    expect(a.primary.verdict).toBe("holds");
    expect(a.compare.verdict).toBe("holds");
    expect(a.agree).toBe(true);
    expect(b.primary.verdict).toBe("outdated");
    expect(b.compare.verdict).toBe("unclear");
    expect(b.agree).toBe(false);
  });

  it("only compares code-changed findings, matching judgeStaleFindings", async () => {
    const findings = [finding("a.md"), { ...finding("b.md"), reason: "expired" as const }];

    const results = await compareJudges(findings, {
      primary: fakeJudge({ "a.md": "holds" }),
      compare: fakeJudge({ "a.md": "holds" }),
      diff: () => "d",
      conceptBody: (c) => c,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.concept).toBe("a.md");
  });
});

describe("formatCompareReport", () => {
  it("reports 100% agreement with no disagreement table when everything matches", () => {
    const output = formatCompareReport([
      { concept: "a.md", primary: { verdict: "holds", reason: "x" }, compare: { verdict: "holds", reason: "y" }, agree: true },
    ]);
    expect(output).toContain("1/1");
    expect(output).toContain("100%");
    expect(output).not.toContain("disagreement");
  });

  it("lists each disagreement with both verdicts", () => {
    const output = formatCompareReport([
      { concept: "a.md", primary: { verdict: "holds", reason: "x" }, compare: { verdict: "holds", reason: "y" }, agree: true },
      { concept: "b.md", primary: { verdict: "outdated", reason: "x" }, compare: { verdict: "unclear", reason: "y" }, agree: false },
    ]);
    expect(output).toContain("1/2");
    expect(output).toContain("50%");
    expect(output).toContain("b.md");
    expect(output).toContain("outdated");
    expect(output).toContain("unclear");
  });

  it("says plainly when there was nothing eligible to compare", () => {
    expect(formatCompareReport([])).toContain("no eligible findings");
  });
});
