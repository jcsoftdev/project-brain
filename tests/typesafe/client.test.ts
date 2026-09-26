import { describe, it, expect } from "bun:test";
import { ask } from "../../src/typesafe/client.js";

function fakeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response
): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => handler(url, init);
}

describe("ask", () => {
  it("posts one request with model/state/questions and returns typed answers keyed the same as the questions", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    let capturedHeaders: Record<string, string> = {};
    const fetchFn = fakeFetch((url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      capturedHeaders = init.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          model: "jev-1.0",
          answers: {
            n: { type: "noul", noul: 0.87 },
            c: { type: "choice", choice: "outdated", confidence: 0.78, probabilities: { holds: 0.1, outdated: 0.78, unclear: 0.12 } },
            s: { type: "score", score: 1, confidence: 1, probabilities: { "0": 0, "1": 1 }, legend: { "0": "low", "1": "high" } },
          },
          usage: { input_tokens: 10 },
        }),
        { status: 200 }
      );
    });

    const answers = await ask(
      "secret-token",
      { subject: "fix: x" },
      {
        n: { type: "noul", instructions: "is it surprising" },
        c: { type: "choice", instructions: "pick one", criteria: { holds: "still true", outdated: "no longer true", unclear: "unsure" } },
        s: { type: "score", instructions: "how worthy", criteria: ["low", "high"] },
      },
      { fetchFn }
    );

    expect(capturedUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect(capturedHeaders["Authorization"]).toBe("Bearer secret-token");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedBody.model).toBe("jev-latest");
    expect(capturedBody.state.subject).toBe("fix: x");
    expect(capturedBody.questions.n.type).toBe("noul");
    expect(capturedBody.questions.c.criteria.holds).toBe("still true");

    expect(answers).not.toBeNull();
    expect(answers!.n).toEqual({ type: "noul", noul: 0.87 });
    expect(answers!.c.choice).toBe("outdated");
    expect(answers!.c.confidence).toBe(0.78);
    expect(answers!.s.score).toBe(1);
  });

  it("returns null on a non-2xx response", async () => {
    const fetchFn = fakeFetch(() => new Response("nope", { status: 500 }));
    const answers = await ask("t", {}, { n: { type: "noul", instructions: "x" } }, { fetchFn });
    expect(answers).toBeNull();
  });

  it("returns null on a network failure (timeout, abort, etc.)", async () => {
    const fetchFn = fakeFetch(() => {
      throw new Error("aborted");
    });
    const answers = await ask("t", {}, { n: { type: "noul", instructions: "x" } }, { fetchFn });
    expect(answers).toBeNull();
  });

  it("returns null on a malformed (non-JSON) body", async () => {
    const fetchFn = fakeFetch(() => new Response("not json", { status: 200 }));
    const answers = await ask("t", {}, { n: { type: "noul", instructions: "x" } }, { fetchFn });
    expect(answers).toBeNull();
  });

  it("returns null when an answer is missing for a question", async () => {
    const fetchFn = fakeFetch(
      () => new Response(JSON.stringify({ answers: {} }), { status: 200 })
    );
    const answers = await ask("t", {}, { n: { type: "noul", instructions: "x" } }, { fetchFn });
    expect(answers).toBeNull();
  });

  it("returns null when a noul answer's value is not a number", async () => {
    const fetchFn = fakeFetch(
      () => new Response(JSON.stringify({ answers: { n: { noul: "high" } } }), { status: 200 })
    );
    const answers = await ask("t", {}, { n: { type: "noul", instructions: "x" } }, { fetchFn });
    expect(answers).toBeNull();
  });

  it("returns null when a choice answer is missing confidence or probabilities", async () => {
    const fetchFn = fakeFetch(
      () => new Response(JSON.stringify({ answers: { c: { choice: "holds" } } }), { status: 200 })
    );
    const answers = await ask(
      "t",
      {},
      { c: { type: "choice", instructions: "x", criteria: { holds: "a", outdated: "b" } } },
      { fetchFn }
    );
    expect(answers).toBeNull();
  });

  it("returns null when a score answer is missing confidence or probabilities", async () => {
    const fetchFn = fakeFetch(
      () => new Response(JSON.stringify({ answers: { s: { score: 1 } } }), { status: 200 })
    );
    const answers = await ask("t", {}, { s: { type: "score", instructions: "x", criteria: ["a", "b"] } }, { fetchFn });
    expect(answers).toBeNull();
  });

  it("never serializes the token into the request body", async () => {
    const fetchFn = fakeFetch((_url, init) => {
      expect(String(init.body)).not.toContain("super-secret");
      return new Response(JSON.stringify({ answers: { n: { noul: 0.1 } } }));
    });
    await ask("super-secret", {}, { n: { type: "noul", instructions: "x" } }, { fetchFn });
  });

  it("respects a custom timeout via AbortSignal", async () => {
    let sawSignal = false;
    const fetchFn = fakeFetch((_url, init) => {
      sawSignal = init.signal instanceof AbortSignal;
      return new Response(JSON.stringify({ answers: { n: { noul: 0.1 } } }));
    });
    await ask("t", {}, { n: { type: "noul", instructions: "x" } }, { fetchFn, timeoutMs: 50 });
    expect(sawSignal).toBe(true);
  });
});
