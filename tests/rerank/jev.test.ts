import { describe, it, expect } from "bun:test";
import { JevReranker } from "../../src/rerank/jev.js";

function fakeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response
): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => handler(url, init);
}

describe("JevReranker", () => {
  it("posts one request with query + capped candidate content and returns noul scores in order", async () => {
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
          answers: { c0: { type: "noul", noul: 0.9 }, c1: { type: "noul", noul: 0.2 } },
          usage: { input_tokens: 10 },
        }),
        { status: 200 }
      );
    });

    const reranker = new JevReranker("secret-token", { fetchFn });
    const scores = await reranker.rerank("how does auth work", [
      { file: "a.ts", symbol: "auth", content: "x".repeat(2000) },
      { file: "b.ts", content: "short" },
    ]);

    expect(capturedUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect(capturedHeaders["Authorization"]).toBe("Bearer secret-token");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedBody.model).toBe("jev-latest");
    expect(capturedBody.state.query).toBe("how does auth work");
    expect(capturedBody.state.candidates.c0.file).toBe("a.ts");
    expect(capturedBody.state.candidates.c0.symbol).toBe("auth");
    expect(capturedBody.state.candidates.c0.content.length).toBe(1200);
    expect(capturedBody.state.candidates.c1.content).toBe("short");
    expect(capturedBody.state.candidates.c1.symbol).toBeUndefined();
    expect(capturedBody.questions.c0.type).toBe("noul");
    expect(typeof capturedBody.questions.c0.instructions).toBe("string");

    expect(scores).toEqual([0.9, 0.2]);
  });

  it("returns null on a non-2xx response", async () => {
    const fetchFn = fakeFetch(() => new Response("nope", { status: 500 }));
    const reranker = new JevReranker("t", { fetchFn });
    const scores = await reranker.rerank("q", [{ file: "a.ts", content: "x" }]);
    expect(scores).toBeNull();
  });

  it("returns null on a network failure (timeout, abort, etc.)", async () => {
    const fetchFn = fakeFetch(() => {
      throw new Error("aborted");
    });
    const reranker = new JevReranker("t", { fetchFn });
    const scores = await reranker.rerank("q", [{ file: "a.ts", content: "x" }]);
    expect(scores).toBeNull();
  });

  it("returns null on a malformed (non-JSON) body", async () => {
    const fetchFn = fakeFetch(() => new Response("not json", { status: 200 }));
    const reranker = new JevReranker("t", { fetchFn });
    const scores = await reranker.rerank("q", [{ file: "a.ts", content: "x" }]);
    expect(scores).toBeNull();
  });

  it("returns null when an answer is missing for a candidate", async () => {
    const fetchFn = fakeFetch(
      () => new Response(JSON.stringify({ answers: { c0: { noul: 0.5 } } }), { status: 200 })
    );
    const reranker = new JevReranker("t", { fetchFn });
    const scores = await reranker.rerank("q", [
      { file: "a.ts", content: "x" },
      { file: "b.ts", content: "y" },
    ]);
    expect(scores).toBeNull();
  });

  it("returns [] without calling fetch for an empty candidate pool", async () => {
    let called = false;
    const fetchFn = fakeFetch(() => {
      called = true;
      return new Response("{}");
    });
    const reranker = new JevReranker("t", { fetchFn });
    const scores = await reranker.rerank("q", []);
    expect(scores).toEqual([]);
    expect(called).toBe(false);
  });

  it("never serializes the token into the request body", async () => {
    const fetchFn = fakeFetch((_url, init) => {
      expect(String(init.body)).not.toContain("super-secret");
      return new Response(JSON.stringify({ answers: { c0: { noul: 0.1 } } }));
    });
    const reranker = new JevReranker("super-secret", { fetchFn });
    await reranker.rerank("q", [{ file: "a.ts", content: "x" }]);
  });
});
