import { describe, it, expect } from "bun:test";
import { JevReranker } from "../../src/rerank/jev.js";
import { formatRerankerProbeLine, probeReranker } from "../../src/rerank/probe.js";
import { runHealth } from "../../src/commands/health.js";
import { handleHealth } from "../../src/tools/health.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore } from "../../src/types.js";

const TOKEN = "secret-token-do-not-leak";

const okFetch = async () =>
  new Response(
    JSON.stringify({ answers: { c0: { type: "noul", noul: 0.89 }, c1: { type: "noul", noul: 0.07 } } }),
    { status: 200 }
  );

/** Returns 0 then `elapsed` so the probe's two clock reads yield a known latency. */
function clock(elapsed: number): () => number {
  const ticks = [0, elapsed];
  return () => ticks.shift() ?? elapsed;
}

describe("probeReranker", () => {
  it("reports reachable with the measured latency", async () => {
    const probe = await probeReranker(new JevReranker(TOKEN, { fetchFn: okFetch }), clock(737));
    expect(probe).toEqual({ status: "reachable", latencyMs: 737 });
    expect(formatRerankerProbeLine(probe)).toBe("Jev probe: reachable (737ms)");
  });

  it("sends exactly 2 fixed synthetic candidates", async () => {
    let body: any;
    const fetchFn = async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return okFetch();
    };
    await probeReranker(new JevReranker(TOKEN, { fetchFn }));
    expect(Object.keys(body.state.candidates)).toEqual(["c0", "c1"]);
  });

  it("names a timeout", async () => {
    const fetchFn = async () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    const probe = await probeReranker(new JevReranker(TOKEN, { fetchFn }), clock(1500));
    expect(probe).toEqual({ status: "degraded", reason: "timeout", latencyMs: 1500 });
    expect(formatRerankerProbeLine(probe)).toContain("degraded — timeout");
  });

  it("names the http status of an expired token", async () => {
    const fetchFn = async () => new Response("unauthorized", { status: 401 });
    const probe = await probeReranker(new JevReranker(TOKEN, { fetchFn }), clock(80));
    expect(probe).toMatchObject({ status: "degraded", reason: "http 401" });
  });

  it("names a malformed response", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ answers: { c0: { type: "noul", noul: 0.5 } } }), { status: 200 });
    const probe = await probeReranker(new JevReranker(TOKEN, { fetchFn }));
    expect(probe).toMatchObject({ status: "degraded", reason: "malformed response" });
  });

  it("names a network error without leaking the token", async () => {
    const fetchFn = async () => {
      throw new Error(`connect ECONNREFUSED ${TOKEN}`);
    };
    const probe = await probeReranker(new JevReranker(TOKEN, { fetchFn }));
    expect(probe).toMatchObject({ status: "degraded", reason: "network error" });
    expect(JSON.stringify(probe)).not.toContain(TOKEN);
    expect(formatRerankerProbeLine(probe)).not.toContain(TOKEN);
  });

  it("degrades a reranker without rerankWithReason when it returns null or throws", async () => {
    const nullish = await probeReranker({ rerank: async () => null });
    const throwing = await probeReranker({
      rerank: async () => {
        throw new Error("boom");
      },
    });
    expect(nullish.status).toBe("degraded");
    expect(throwing.status).toBe("degraded");
  });

  it("is not-configured with no reranker and prints no line", async () => {
    const probe = await probeReranker(undefined);
    expect(probe).toEqual({ status: "not-configured" });
    expect(formatRerankerProbeLine(probe)).toBeUndefined();
  });
});

const store = { countChunks: async () => 0 } as unknown as VectorStore;
const embeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
  embed: async (t) => t.map(() => [0.1]),
  isAvailable: async () => true,
};

describe("health wiring", () => {
  it("runHealth probes the injected reranker with the injected clock", async () => {
    const result = await runHealth({
      projectId: "demo",
      store,
      embeddings,
      dbPath: "/nonexistent",
      reranker: "on",
      rerankerTokenSource: "env",
      rerankerClient: new JevReranker(TOKEN, { fetchFn: okFetch }),
      now: clock(737),
    });
    expect(result.rerankerProbe).toEqual({ status: "reachable", latencyMs: 737 });
  });

  it("runHealth reports not-configured when the reranker is off", async () => {
    const result = await runHealth({ projectId: "demo", store, embeddings, dbPath: "/nonexistent" });
    expect(result.rerankerProbe).toEqual({ status: "not-configured" });
  });

  it("check_health surfaces a degraded probe", async () => {
    const fetchFn = async () => new Response("no", { status: 401 });
    const result = await handleHealth(
      { project: "demo" },
      { store, embeddings, reranker: new JevReranker(TOKEN, { fetchFn }) }
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.rerankerProbe).toMatchObject({ status: "degraded", reason: "http 401" });
    expect(result.content[0].text).not.toContain(TOKEN);
  });

  it("check_health reports not-configured with no reranker", async () => {
    const result = await handleHealth({ project: "demo" }, { store, embeddings });
    expect(JSON.parse(result.content[0].text).rerankerProbe).toEqual({ status: "not-configured" });
  });
});
