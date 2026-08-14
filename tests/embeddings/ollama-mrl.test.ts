import { describe, it, expect, afterEach } from "bun:test";
import { OllamaEmbeddingClient } from "../../src/embeddings/ollama.js";

let server: ReturnType<typeof Bun.serve> | null = null;

/** Serves a fixed-width embedding per input, so we can assert what the client
 *  does with a response WIDER than the dimension it was configured for. */
function serveVectors(width: number) {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { input: string[] };
      const embeddings = body.input.map(() =>
        Array.from({ length: width }, (_, i) => i + 1)
      );
      return Response.json({ embeddings });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

afterEach(() => {
  server?.stop(true);
  server = null;
});

const l2 = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe("OllamaEmbeddingClient MRL truncation", () => {
  it("truncates a wider response to the configured dim for an MRL model", async () => {
    const host = serveVectors(1024);
    const client = new OllamaEmbeddingClient(host, 0, "qwen3-embedding:0.6b", 512);

    const out = await client.embed(["hello"]);

    expect(out).not.toBeNull();
    expect(out![0]).toHaveLength(512);
  });

  it("re-normalizes the truncated vector to unit length", async () => {
    const host = serveVectors(1024);
    const client = new OllamaEmbeddingClient(host, 0, "qwen3-embedding:0.6b", 512);

    const out = await client.embed(["hello"]);

    expect(l2(out![0]!)).toBeCloseTo(1, 10);
  });

  it("refuses to truncate a model not known to be Matryoshka-trained", async () => {
    // Returning a silently-degraded embedding is worse than returning nothing:
    // searches keep working and just get quietly worse.
    const host = serveVectors(1024);
    const client = new OllamaEmbeddingClient(host, 0, "mystery-embed", 512);

    expect(await client.embed(["hello"])).toBeNull();
  });

  it("passes a matching-width response through untouched", async () => {
    const host = serveVectors(768);
    const client = new OllamaEmbeddingClient(host, 0, "nomic-embed-text", 768);

    const out = await client.embed(["hello"]);

    expect(out![0]).toHaveLength(768);
    expect(out![0]![0]).toBe(1); // unscaled — no renormalisation applied
  });

  it("does not fabricate dimensions when the response is narrower", async () => {
    const host = serveVectors(256);
    const client = new OllamaEmbeddingClient(host, 0, "qwen3-embedding:0.6b", 512);

    expect(await client.embed(["hello"])).toBeNull();
  });
});
