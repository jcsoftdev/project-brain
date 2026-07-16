import { describe, it, expect, afterEach } from "bun:test";
import {
  computeEmbedTuning,
  detectEmbedTuning,
  type MachineSnapshot,
} from "../../src/embeddings/auto-tune.js";

describe("computeEmbedTuning", () => {
  it("vram-contention: another model loaded in Ollama → concurrency=1, batchSize=16", () => {
    const snap: MachineSnapshot = { cores: 12, freeMemBytes: 16 * 1024 ** 3, ollamaBusy: true };
    const tuning = computeEmbedTuning(snap);
    expect(tuning.concurrency).toBe(1);
    expect(tuning.batchSize).toBe(16);
    expect(tuning.reason).toBe("vram-contention");
  });

  it("low-memory: free mem below 4 GiB → concurrency=1, batchSize=32", () => {
    const snap: MachineSnapshot = { cores: 12, freeMemBytes: 2 * 1024 ** 3, ollamaBusy: false };
    const tuning = computeEmbedTuning(snap);
    expect(tuning.concurrency).toBe(1);
    expect(tuning.batchSize).toBe(32);
    expect(tuning.reason).toBe("low-memory");
  });

  it("default: cores=12, no contention, plenty of memory → concurrency=1, batchSize=64 (local Ollama is GPU-compute-bound, not I/O-bound — see auto-tune.ts rule 3 comment)", () => {
    const snap: MachineSnapshot = { cores: 12, freeMemBytes: 16 * 1024 ** 3, ollamaBusy: false };
    const tuning = computeEmbedTuning(snap);
    expect(tuning.concurrency).toBe(1);
    expect(tuning.batchSize).toBe(64);
  });

  it("cores no longer affect concurrency: cores=2 and cores=16 both → concurrency=1", () => {
    const low: MachineSnapshot = { cores: 2, freeMemBytes: 16 * 1024 ** 3, ollamaBusy: false };
    const high: MachineSnapshot = { cores: 16, freeMemBytes: 16 * 1024 ** 3, ollamaBusy: false };
    expect(computeEmbedTuning(low).concurrency).toBe(1);
    expect(computeEmbedTuning(high).concurrency).toBe(1);
    expect(computeEmbedTuning(low).batchSize).toBe(64);
    expect(computeEmbedTuning(high).batchSize).toBe(64);
  });

  it("ollamaBusy takes priority over low-memory (contention check runs first)", () => {
    const snap: MachineSnapshot = { cores: 12, freeMemBytes: 1 * 1024 ** 3, ollamaBusy: true };
    const tuning = computeEmbedTuning(snap);
    expect(tuning.reason).toBe("vram-contention");
  });
});

let server: ReturnType<typeof Bun.serve> | null = null;
let port: number;

function startMockServer(handler: (req: Request) => Response | Promise<Response>) {
  server = Bun.serve({ port: 0, fetch: handler });
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

describe("detectEmbedTuning", () => {
  afterEach(() => {
    stopMockServer();
  });

  it("ollamaBusy=true when /api/ps lists a model other than the embed model", async () => {
    const host = startMockServer((_req) => {
      return new Response(
        JSON.stringify({ models: [{ name: "llama3:latest" }, { name: "nomic-embed-text" }] }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    const tuning = await detectEmbedTuning(host, "nomic-embed-text");
    expect(tuning.reason).toBe("vram-contention");
    expect(tuning.concurrency).toBe(1);
    expect(tuning.batchSize).toBe(16);
  });

  it("ollamaBusy=false when /api/ps only lists the embed model itself", async () => {
    const host = startMockServer((_req) => {
      return new Response(JSON.stringify({ models: [{ name: "nomic-embed-text" }] }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    const tuning = await detectEmbedTuning(host, "nomic-embed-text");
    expect(tuning.reason).not.toBe("vram-contention");
  });

  it("ollamaBusy=false when /api/ps lists no models", async () => {
    const host = startMockServer((_req) => {
      return new Response(JSON.stringify({ models: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    const tuning = await detectEmbedTuning(host, "nomic-embed-text");
    expect(tuning.reason).not.toBe("vram-contention");
  });

  it("fails open (no throw) and returns a default-equivalent tuning when the host is unreachable", async () => {
    const tuning = await detectEmbedTuning("http://127.0.0.1:1", "nomic-embed-text");
    expect(tuning).toBeTruthy();
    expect(tuning.reason).not.toBe("vram-contention");
  });

  it("fails open on a slow/hanging /api/ps (probe must not block sync)", async () => {
    const host = startMockServer(async (_req) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return new Response(JSON.stringify({ models: [] }));
    });

    const start = Date.now();
    const tuning = await detectEmbedTuning(host, "nomic-embed-text");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2_000); // aborted well before the 5s handler resolves
    expect(tuning.reason).not.toBe("vram-contention");
  });
});
