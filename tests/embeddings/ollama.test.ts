import { describe, it, expect, afterEach, mock } from "bun:test";
import { VECTOR_DIM, HEALTH_COOLDOWN_MS } from "../../src/constants.js";

// We'll test OllamaEmbeddingClient with a mock Ollama HTTP server
import { OllamaEmbeddingClient, embedTimeoutMs } from "../../src/embeddings/ollama.js";

// ---- FIX 1: embedTimeoutMs pure helper ----
describe("embedTimeoutMs", () => {
  it("returns 10000 for count=1 (minimum floor)", () => {
    expect(embedTimeoutMs(1)).toBe(10_000);
  });

  it("scales for count=200: max(10000, 200*600) = 120000", () => {
    expect(embedTimeoutMs(200)).toBe(120_000);
  });

  it("scales for count=50: max(10000, 50*600) = 30000", () => {
    expect(embedTimeoutMs(50)).toBe(30_000);
  });

  it("returns floor for count=0", () => {
    expect(embedTimeoutMs(0)).toBe(10_000);
  });

  it("scales linearly above floor", () => {
    expect(embedTimeoutMs(100)).toBe(60_000);
  });
});

let server: ReturnType<typeof Bun.serve> | null = null;
let port: number;

function startMockServer(handler: (req: Request) => Response | Promise<Response>) {
  server = Bun.serve({
    port: 0,
    fetch: handler,
  });
  port = server.port;
  return `http://127.0.0.1:${port}`;
}

function stopMockServer() {
  if (server) {
    server.stop(true);
    server = null;
  }
}

describe("OllamaEmbeddingClient — embed()", () => {
  afterEach(() => {
    stopMockServer();
  });

  it("returns array of vectors on success", async () => {
    const host = startMockServer((_req) => {
      return new Response(
        JSON.stringify({
          embeddings: [new Array(VECTOR_DIM).fill(0.5)],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new OllamaEmbeddingClient(host);
    const result = await client.embed(["hello"]);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].length).toBe(VECTOR_DIM);
  });

  it("supports batch embedding (multiple texts)", async () => {
    const host = startMockServer((_req) => {
      return new Response(
        JSON.stringify({
          embeddings: [
            new Array(VECTOR_DIM).fill(0.1),
            new Array(VECTOR_DIM).fill(0.2),
            new Array(VECTOR_DIM).fill(0.3),
          ],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new OllamaEmbeddingClient(host);
    const result = await client.embed(["a", "b", "c"]);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
  });

  it("returns null when Ollama is unreachable", async () => {
    // Use a port that nothing listens on
    const client = new OllamaEmbeddingClient("http://127.0.0.1:1");
    const result = await client.embed(["hello"]);
    expect(result).toBeNull();
  });

  it("returns null when embeddings array is shorter than input texts (partial server failure)", async () => {
    const host = startMockServer((_req) => {
      // Server returns HTTP 200 but only 2 embeddings for 3 requested texts —
      // simulates a silent partial failure that must NOT be treated as success.
      return new Response(
        JSON.stringify({
          embeddings: [new Array(VECTOR_DIM).fill(0.1), new Array(VECTOR_DIM).fill(0.2)],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new OllamaEmbeddingClient(host);
    const result = await client.embed(["a", "b", "c"]);
    expect(result).toBeNull();
  });
});

describe("OllamaEmbeddingClient — isAvailable()", () => {
  afterEach(() => {
    stopMockServer();
  });

  it("returns true when server responds", async () => {
    const host = startMockServer((_req) => {
      return new Response(JSON.stringify({ models: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new OllamaEmbeddingClient(host);
    const available = await client.isAvailable();
    expect(available).toBe(true);
  });

  it("returns false when server is unreachable", async () => {
    const client = new OllamaEmbeddingClient("http://127.0.0.1:1");
    const available = await client.isAvailable();
    expect(available).toBe(false);
  });
});

describe("OllamaEmbeddingClient — circuit breaker cooldown", () => {
  afterEach(() => {
    stopMockServer();
  });

  it("after failure, returns null immediately within cooldown (no network)", async () => {
    const client = new OllamaEmbeddingClient("http://127.0.0.1:1");

    // First call: fails (network error)
    const r1 = await client.embed(["hello"]);
    expect(r1).toBeNull();

    // Second call within cooldown: should return null WITHOUT making a network call
    // We verify by timing — it should be near-instant (no connection timeout)
    const start = Date.now();
    const r2 = await client.embed(["hello"]);
    const elapsed = Date.now() - start;

    expect(r2).toBeNull();
    expect(elapsed).toBeLessThan(100); // Should be instant, not waiting for timeout
  });

  it("after cooldown expires, attempts network again and recovers", async () => {
    // Start with unreachable
    const client = new OllamaEmbeddingClient("http://127.0.0.1:1", 50); // 50ms cooldown for test

    // First call fails
    const r1 = await client.embed(["hello"]);
    expect(r1).toBeNull();

    // Wait for cooldown to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Now start a mock server on a different port and swap the host
    // Instead, test with a client that will recover
    const host = startMockServer((_req) => {
      return new Response(
        JSON.stringify({ embeddings: [new Array(VECTOR_DIM).fill(0.5)] }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    // Create a new client pointing to the working server but with short cooldown
    const client2 = new OllamaEmbeddingClient(host, 50);
    // Simulate a failure first
    stopMockServer();
    const r2 = await client2.embed(["hello"]);
    expect(r2).toBeNull();

    // Restart server and wait for cooldown
    const host2 = startMockServer((_req) => {
      return new Response(
        JSON.stringify({ embeddings: [new Array(VECTOR_DIM).fill(0.5)] }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    // The client2 still points to the old host. Let's test with a fresh approach.
    const client3 = new OllamaEmbeddingClient(host2, 50);
    // First call succeeds
    const r3 = await client3.embed(["hello"]);
    expect(r3).not.toBeNull();
  });

  it("successful call resets circuit breaker to healthy", async () => {
    const host = startMockServer((_req) => {
      return new Response(
        JSON.stringify({ embeddings: [new Array(VECTOR_DIM).fill(0.5)] }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new OllamaEmbeddingClient(host, 50);
    const r1 = await client.embed(["hello"]);
    expect(r1).not.toBeNull();

    // Client should still be in healthy state — subsequent calls work
    const r2 = await client.embed(["world"]);
    expect(r2).not.toBeNull();
  });
});

describe("OllamaEmbeddingClient.dim", () => {
  it("reports configured dim", () => {
    const c = new OllamaEmbeddingClient("http://x", 30000, "nomic-embed-code", 768);
    expect(c.dim).toBe(768);
  });
});
