import { describe, it, expect } from "bun:test";
import { createJevJudge } from "../../src/okf/jev-judge.js";
import type { TypesafeFetchFn } from "../../src/typesafe/client.js";

function fakeFetch(handler: (init: RequestInit) => Response): TypesafeFetchFn {
  return async (_url, init) => handler(init);
}

function choiceResponse(choice: string, confidence: number) {
  return new Response(
    JSON.stringify({
      answers: {
        verdict: {
          type: "choice",
          choice,
          confidence,
          probabilities: { holds: 0.1, outdated: 0.1, unclear: 0.1, [choice]: confidence },
        },
      },
    }),
    { status: 200 }
  );
}

describe("createJevJudge", () => {
  it("sends the concept body and diff as state, and asks a choice question over the three verdicts", async () => {
    let capturedBody: any = null;
    const fetchFn = fakeFetch((init) => {
      capturedBody = JSON.parse(init.body as string);
      return choiceResponse("holds", 0.9);
    });

    const judge = createJevJudge("tok", { fetchFn });
    const result = await judge.judge({ conceptBody: "the concept prose", diff: "the git diff" });

    expect(capturedBody.state.conceptBody).toBe("the concept prose");
    expect(capturedBody.state.diff).toBe("the git diff");
    expect(capturedBody.questions.verdict.type).toBe("choice");
    expect(Object.keys(capturedBody.questions.verdict.criteria).sort()).toEqual(["holds", "outdated", "unclear"]);
    expect(result.verdict).toBe("holds");
    expect(result.reason).toContain("0.9");
  });

  it("maps a confident 'outdated' choice straight through", async () => {
    const judge = createJevJudge("tok", { fetchFn: fakeFetch(() => choiceResponse("outdated", 0.82)) });
    const result = await judge.judge({ conceptBody: "x", diff: "y" });
    expect(result.verdict).toBe("outdated");
  });

  it("downgrades a low-confidence choice to unclear", async () => {
    const judge = createJevJudge("tok", { fetchFn: fakeFetch(() => choiceResponse("outdated", 0.4)) });
    const result = await judge.judge({ conceptBody: "x", diff: "y" });
    expect(result.verdict).toBe("unclear");
    expect(result.reason).toContain("0.4");
  });

  it("respects a custom confidence threshold", async () => {
    const judge = createJevJudge("tok", { fetchFn: fakeFetch(() => choiceResponse("holds", 0.7)), minConfidence: 0.8 });
    const result = await judge.judge({ conceptBody: "x", diff: "y" });
    expect(result.verdict).toBe("unclear");
  });

  it("returns unclear, never throws, when Jev fails (network/timeout/malformed)", async () => {
    const judge = createJevJudge("tok", {
      fetchFn: fakeFetch(() => new Response("nope", { status: 500 })),
    });
    const result = await judge.judge({ conceptBody: "x", diff: "y" });
    expect(result.verdict).toBe("unclear");
    expect(result.reason).toBeTruthy();
  });

  it("never serializes the token into the request body", async () => {
    const judge = createJevJudge("super-secret", {
      fetchFn: fakeFetch((init) => {
        expect(String(init.body)).not.toContain("super-secret");
        return choiceResponse("holds", 0.9);
      }),
    });
    await judge.judge({ conceptBody: "x", diff: "y" });
  });
});
