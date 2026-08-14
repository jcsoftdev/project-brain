import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHttpServer } from "../src/server-http.js";
import type { EmbeddingClient } from "../src/types.js";

/**
 * `HttpServerOptions` advertises `embeddings` as "DI: injectable embedding
 * client for tests", but createHttpServer never forwarded it to createServer —
 * so every HTTP server, including the ones under test, probed the real Ollama
 * on startup.
 *
 * That probe costs 2.7s against an idle Ollama and over 5s against a busy one,
 * which timed out three unrelated tests in this suite on any machine that
 * happens to be running Ollama. CI never saw it: with no Ollama listening the
 * probe fails in 6ms.
 *
 * The property that matters is behavioural, not structural — an injected
 * client means NO network call — so these tests count requests against a fake
 * Ollama rather than mocking the factory module.
 */
describe("createHttpServer DI", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) await fn();
    cleanup = [];
  });

  /** A stand-in Ollama that records every path it is asked for. */
  function fakeOllama() {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        paths.push(new URL(req.url).pathname);
        return Response.json({ models: [{ name: "nomic-embed-text:latest" }] });
      },
    });
    cleanup.push(async () => {
      server.stop(true);
    });
    return { paths, host: `http://127.0.0.1:${server.port}` };
  }

  const stubEmbeddings: EmbeddingClient = {
    model: "stub",
    dim: 4,
    embed: async (texts: string[]) => texts.map(() => [0, 0, 0, 0]),
  } as unknown as EmbeddingClient;

  async function serve(opts: Record<string, unknown>) {
    const dir = await mkdtemp(join(tmpdir(), "pb-http-di-"));
    const handle = await createHttpServer({
      port: 0,
      token: "tok",
      dbPath: dir,
      ...opts,
    } as never);
    cleanup.push(async () => {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    });
    return handle;
  }

  it("probes Ollama when no embedding client is injected", async () => {
    const ollama = fakeOllama();

    await serve({ ollamaHost: ollama.host });

    // Guards the test itself: if startup stopped probing for an unrelated
    // reason, the test below would pass while proving nothing.
    expect(ollama.paths.length).toBeGreaterThan(0);
  });

  it("makes no Ollama request at all when an embedding client is injected", async () => {
    const ollama = fakeOllama();

    await serve({ ollamaHost: ollama.host, embeddings: stubEmbeddings });

    expect(ollama.paths).toEqual([]);
  });
});
