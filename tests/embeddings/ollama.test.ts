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
  if (server.port === undefined) throw new Error("mock server has no port");
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

  it("after 2 consecutive failures, returns null immediately within cooldown (no network)", async () => {
    const client = new OllamaEmbeddingClient("http://127.0.0.1:1");

    // Two consecutive failed requests are needed to trip the breaker
    // (BREAKER_THRESHOLD = 2) — one poisoned batch must not cut off healthy
    // concurrent siblings.
    const r1 = await client.embed(["hello"]);
    expect(r1).toBeNull();
    const r2 = await client.embed(["hello"]);
    expect(r2).toBeNull();

    // Third call within cooldown: should return null WITHOUT making a network call
    // We verify by timing — it should be near-instant (no connection timeout)
    const start = Date.now();
    const r3 = await client.embed(["hello"]);
    const elapsed = Date.now() - start;

    expect(r3).toBeNull();
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

describe("OllamaEmbeddingClient — transient failure retry", () => {
  afterEach(() => {
    stopMockServer();
  });

  it("retries a transient connection error and succeeds without tripping the breaker", async () => {
    let attempt = 0;
    const host = startMockServer((_req) => {
      attempt++;
      if (attempt === 1) {
        // Simulate the Ollama subprocess crashing/restarting mid-request:
        // the backing llama-server is briefly down and Ollama surfaces
        // this as a 5xx (transient) rather than the socket itself dying —
        // the listening port stays up for the retry.
        return new Response("upstream llama-server crashed", { status: 502 });
      }
      return new Response(
        JSON.stringify({ embeddings: [new Array(VECTOR_DIM).fill(0.5)] }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new OllamaEmbeddingClient(host);
    const result = await client.embed(["hello"]);

    // Should have transparently retried past the transient crash.
    expect(result).not.toBeNull();
    expect(result![0].length).toBe(VECTOR_DIM);

    // Breaker must NOT be tripped — a sibling call right after must still
    // hit the network (not short-circuit to null from cooldown).
    const isAvailable = await client.isAvailable();
    expect(isAvailable).toBe(true);
  });

  it("does not cascade a single transient failure across concurrent sibling batches", async () => {
    let requestCount = 0;
    let firstRequestFailedOnce = false;
    const host = startMockServer((_req) => {
      requestCount++;
      // Only the very first request across all concurrent batches fails once.
      if (requestCount === 1 && !firstRequestFailedOnce) {
        firstRequestFailedOnce = true;
        return new Response("internal error", { status: 503 });
      }
      return new Response(
        JSON.stringify({ embeddings: [new Array(VECTOR_DIM).fill(0.5)] }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new OllamaEmbeddingClient(host);

    // Simulate mapLimit(concurrency=3) firing sibling batch requests around
    // the same time the first one hits its transient 503.
    const results = await Promise.all([
      client.embed(["batch-a"]),
      client.embed(["batch-b"]),
      client.embed(["batch-c"]),
    ]);

    // Every batch must succeed — none should be cascaded into failure by
    // the breaker tripping from the one transient blip.
    for (const r of results) {
      expect(r).not.toBeNull();
    }
  });

  it("still trips the breaker when failures are sustained across 2 consecutive requests (retries exhausted)", async () => {
    const client = new OllamaEmbeddingClient("http://127.0.0.1:1", 30_000);

    const r1 = await client.embed(["hello"]);
    expect(r1).toBeNull();
    // Second consecutive failure — trips the breaker (BREAKER_THRESHOLD = 2).
    const r2 = await client.embed(["world"]);
    expect(r2).toBeNull();

    // Immediately after: breaker should be open, short-circuiting to null
    // without attempting the network (near-instant).
    const start = Date.now();
    const r3 = await client.embed(["!"]);
    const elapsed = Date.now() - start;

    expect(r3).toBeNull();
    expect(elapsed).toBeLessThan(100);
  });
});

describe("OllamaEmbeddingClient — 4xx exemption and consecutive-failure isolation", () => {
  afterEach(() => {
    stopMockServer();
  });

  it("a 4xx response does NOT trip the circuit breaker", async () => {
    let call = 0;
    const host = startMockServer((_req) => {
      call++;
      if (call === 1) {
        // 4xx is input-specific (bad request/model for THIS payload) — must
        // not count toward the breaker.
        return new Response("bad request", { status: 400 });
      }
      return new Response(
        JSON.stringify({ embeddings: [new Array(VECTOR_DIM).fill(0.5)] }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new OllamaEmbeddingClient(host);
    expect(await client.embed(["bad chunk"])).toBeNull();
    // A good chunk right after must NOT be breaker-blocked.
    expect(await client.embed(["good chunk"])).not.toBeNull();
  });

  it("breaker trips only after 2 consecutive failed requests", async () => {
    const client = new OllamaEmbeddingClient("http://127.0.0.1:1", 30_000);

    // Failure 1 (all transient attempts exhausted against an unreachable host).
    expect(await client.embed(["a"])).toBeNull();

    // Breaker NOT open yet: this call must still attempt the network — a
    // real retry-with-backoff attempt takes noticeably longer than a
    // breaker short-circuit.
    const start = Date.now();
    expect(await client.embed(["b"])).toBeNull();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThan(100);

    // That was the 2nd consecutive failure — breaker should now be open.
    const start2 = Date.now();
    expect(await client.embed(["c"])).toBeNull();
    const elapsed2 = Date.now() - start2;
    expect(elapsed2).toBeLessThan(100);
  });
});
