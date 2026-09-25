import { describe, it, expect } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import {
  applyJudgeVerdicts,
  judgeStaleFindings,
  parseJudgeResponse,
  type JudgeResult,
  type StaleJudge,
} from "../../src/okf/judge.js";
import type { StaleFinding } from "../../src/okf/audit.js";

/** A "code-changed" finding — the only reason `--judge` ever looks at. */
function codeChangedFinding(concept: string, overrides: Partial<StaleFinding> = {}): StaleFinding {
  return {
    concept,
    resource: "../src/a.ts",
    path: "src/a.ts",
    attestedAt: "2026-01-01T00:00:00Z",
    changedAt: "2026-06-01T00:00:00Z",
    reason: "code-changed",
    range: null,
    ...overrides,
  };
}

describe("parseJudgeResponse", () => {
  it("parses the verdict from the text block", () => {
    const result = parseJudgeResponse({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"verdict":"holds","reason":"still true"}' }],
    });

    expect(result).toEqual({ verdict: "holds", reason: "still true" });
  });

  it("skips a leading thinking block to find the text block", () => {
    const result = parseJudgeResponse({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", text: "reasoning about it..." },
        { type: "text", text: '{"verdict":"outdated","reason":"code contradicts it"}' },
      ],
    });

    expect(result).toEqual({ verdict: "outdated", reason: "code contradicts it" });
  });

  it("returns unclear on a refusal stop reason, without reading content", () => {
    const result = parseJudgeResponse({ stop_reason: "refusal", content: [] });

    expect(result.verdict).toBe("unclear");
    expect(result.reason).toContain("refusal");
  });

  it("returns unclear when the response was truncated at max_tokens", () => {
    const result = parseJudgeResponse({ stop_reason: "max_tokens", content: [] });

    expect(result.verdict).toBe("unclear");
    expect(result.reason).toContain("max_tokens");
  });

  it("returns unclear when there is no text block", () => {
    const result = parseJudgeResponse({ stop_reason: "end_turn", content: [{ type: "thinking", text: "..." }] });

    expect(result.verdict).toBe("unclear");
  });

  it("returns unclear when the text block is not valid JSON", () => {
    const result = parseJudgeResponse({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "not json" }],
    });

    expect(result.verdict).toBe("unclear");
  });

  it("returns unclear when the parsed JSON does not match the schema", () => {
    const result = parseJudgeResponse({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"verdict":"maybe","reason":"x"}' }],
    });

    expect(result.verdict).toBe("unclear");
  });
});

describe("applyJudgeVerdicts", () => {
  it("moves a holds verdict out of stale into judged", () => {
    const stale = [codeChangedFinding("g/a.md")];
    const verdicts = new Map<string, JudgeResult>([["g/a.md", { verdict: "holds", reason: "still true" }]]);

    const result = applyJudgeVerdicts(stale, verdicts);

    expect(result.stale).toEqual([]);
    expect(result.judged).toHaveLength(1);
    expect(result.judged[0]).toMatchObject({ concept: "g/a.md", judge: { verdict: "holds", reason: "still true" } });
  });

  it("keeps an outdated verdict in stale, annotated", () => {
    const stale = [codeChangedFinding("g/a.md")];
    const verdicts = new Map<string, JudgeResult>([["g/a.md", { verdict: "outdated", reason: "contradicted" }]]);

    const result = applyJudgeVerdicts(stale, verdicts);

    expect(result.judged).toEqual([]);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0].judge).toEqual({ verdict: "outdated", reason: "contradicted" });
  });

  it("keeps an unclear verdict in stale, annotated", () => {
    const stale = [codeChangedFinding("g/a.md")];
    const verdicts = new Map<string, JudgeResult>([["g/a.md", { verdict: "unclear", reason: "diff too large to judge" }]]);

    const result = applyJudgeVerdicts(stale, verdicts);

    expect(result.judged).toEqual([]);
    expect(result.stale[0].judge?.verdict).toBe("unclear");
  });

  it("leaves a finding with no verdict in stale, unannotated", () => {
    const stale = [codeChangedFinding("g/a.md"), codeChangedFinding("g/b.md")];
    const verdicts = new Map<string, JudgeResult>([["g/a.md", { verdict: "holds", reason: "ok" }]]);

    const result = applyJudgeVerdicts(stale, verdicts);

    expect(result.stale).toHaveLength(1);
    expect(result.stale[0].concept).toBe("g/b.md");
    expect(result.stale[0].judge).toBeUndefined();
  });
});

describe("judgeStaleFindings", () => {
  const fakeJudge = (impl: StaleJudge["judge"]): StaleJudge => ({ judge: impl });

  it("only judges findings whose reason is code-changed", async () => {
    const seen: string[] = [];
    const findings: StaleFinding[] = [
      codeChangedFinding("g/a.md"),
      codeChangedFinding("g/b.md", { reason: "uncommitted", changedAt: null }),
      codeChangedFinding("g/c.md", { reason: "expired", expiresAt: "2026-01-01T00:00:00Z" }),
    ];

    await judgeStaleFindings(findings, {
      judge: fakeJudge(async (input) => {
        seen.push(input.conceptBody);
        return { verdict: "holds", reason: "ok" };
      }),
      diff: () => "some diff",
      conceptBody: (concept) => concept,
    });

    expect(seen).toEqual(["g/a.md"]);
  });

  it("marks a finding unclear without calling judge() when the diff is too large", async () => {
    let called = false;
    const result = await judgeStaleFindings([codeChangedFinding("g/a.md")], {
      judge: fakeJudge(async () => {
        called = true;
        return { verdict: "holds", reason: "ok" };
      }),
      diff: () => "x".repeat(100),
      conceptBody: () => "body",
      maxDiffChars: 10,
    });

    expect(called).toBe(false);
    expect(result.get("g/a.md")).toEqual({ verdict: "unclear", reason: "diff too large to judge" });
  });

  it("marks a finding unclear when judge() throws a RateLimitError, and keeps going", async () => {
    const rateLimitError = new Anthropic.RateLimitError(429, {}, "rate limited", new Headers());
    let calls = 0;
    const result = await judgeStaleFindings(
      [codeChangedFinding("g/a.md"), codeChangedFinding("g/b.md")],
      {
        judge: fakeJudge(async () => {
          calls++;
          if (calls === 1) throw rateLimitError;
          return { verdict: "holds", reason: "ok" };
        }),
        diff: () => "diff",
        conceptBody: () => "body",
        concurrency: 1,
      }
    );

    expect(result.get("g/a.md")?.verdict).toBe("unclear");
    expect(result.get("g/b.md")?.verdict).toBe("holds");
  });

  it("aborts the whole batch when judge() throws AuthenticationError", async () => {
    const authError = new Anthropic.AuthenticationError(401, {}, "bad credentials", new Headers());

    const promise = judgeStaleFindings([codeChangedFinding("g/a.md")], {
      judge: fakeJudge(async () => {
        throw authError;
      }),
      diff: () => "diff",
      conceptBody: () => "body",
    });

    await expect(promise).rejects.toBe(authError);
  });

  it("never runs more than the given concurrency limit at once", async () => {
    let active = 0;
    let maxActive = 0;
    const findings = Array.from({ length: 6 }, (_, i) => codeChangedFinding(`g/${i}.md`));

    await judgeStaleFindings(findings, {
      judge: fakeJudge(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { verdict: "holds", reason: "ok" };
      }),
      diff: () => "diff",
      conceptBody: () => "body",
      concurrency: 2,
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
