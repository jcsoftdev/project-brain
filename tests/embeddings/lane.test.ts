import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_INTERACTIVE_HOST,
  INTERACTIVE_HOST_ENV,
  InteractiveLaneClient,
  fileDeadLaneMemo,
  probeInteractiveLane,
  resolveInteractiveHost,
  withLane,
  type DeadLaneMemo,
} from "../../src/embeddings/lane.js";
import { OllamaEmbeddingClient } from "../../src/embeddings/ollama.js";
import { NullEmbeddingClient } from "../../src/embeddings/null.js";
import { createEmbeddingClient } from "../../src/embeddings/factory.js";
import { makeEmbeddingResolver } from "../../src/embeddings/resolver.js";
import type { EmbeddingClient } from "../../src/types.js";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pb-lane-"));
  dirs.push(dir);
  return dir;
}

interface FakeOllama {
  host: string;
  bodies: unknown[];
}

function vectorFor(model: string, text: string): number[] {
  const seed = [...`${model}|${text}`].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 9973, 7);
  return [seed / 9973, (seed % 97) / 97, (seed % 13) / 13, 1];
}

function fakeOllama(opts: { delayMs?: number; status?: number } = {}): FakeOllama {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/api/tags") return Response.json({ models: [] });
      const body = (await req.json()) as { model: string; input: string[] };
      bodies.push(body);
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      if (opts.status) return new Response("nope", { status: opts.status });
      return Response.json({ embeddings: body.input.map((t) => vectorFor(body.model, t)) });
    },
  });
  servers.push(server);
  return { host: `http://127.0.0.1:${server.port}`, bodies };
}

function memoryMemo(): DeadLaneMemo & { dead: boolean } {
  return {
    dead: false,
    isDead() {
      return this.dead;
    },
    markDead() {
      this.dead = true;
    },
  };
}

const noWarm = () => {};

async function closedPortHost(): Promise<string> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const host = `http://127.0.0.1:${probe.port}`;
  probe.stop(true);
  return host;
}

describe("resolveInteractiveHost", () => {
  it("defaults to port 11435", () => {
    expect(resolveInteractiveHost({ env: {} })).toBe(DEFAULT_INTERACTIVE_HOST);
  });

  it("takes the env override and strips a trailing slash", () => {
    expect(resolveInteractiveHost({ env: { [INTERACTIVE_HOST_ENV]: "http://10.0.0.5:9999/" } })).toBe(
      "http://10.0.0.5:9999"
    );
  });

  it("turns the lane off with `off` from env", () => {
    expect(resolveInteractiveHost({ env: { [INTERACTIVE_HOST_ENV]: "off" } })).toBeNull();
    expect(resolveInteractiveHost({ env: { [INTERACTIVE_HOST_ENV]: "OFF" } })).toBeNull();
  });

  it("reads the config file, and env beats it", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "ollama.json");
    await writeFile(configPath, JSON.stringify({ interactiveHost: "http://127.0.0.1:12000" }));
    expect(resolveInteractiveHost({ env: {}, configPath })).toBe("http://127.0.0.1:12000");
    expect(resolveInteractiveHost({ env: { [INTERACTIVE_HOST_ENV]: "http://127.0.0.1:13000" }, configPath })).toBe(
      "http://127.0.0.1:13000"
    );

    await writeFile(configPath, JSON.stringify({ interactiveHost: "off" }));
    expect(resolveInteractiveHost({ env: {}, configPath })).toBeNull();
  });

  it("ignores a blank env value and an unreadable config", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "ollama.json");
    await writeFile(configPath, "{not json");
    expect(resolveInteractiveHost({ env: { [INTERACTIVE_HOST_ENV]: "  " }, configPath })).toBe(DEFAULT_INTERACTIVE_HOST);
  });
});

describe("fileDeadLaneMemo", () => {
  it("remembers a dead lane for the TTL, across memo instances", async () => {
    const dir = await tempDir();
    let now = 1_000_000;
    const make = () => fileDeadLaneMemo("http://127.0.0.1:11435", { dir, ttlMs: 60_000, now: () => now });

    expect(make().isDead()).toBe(false);
    make().markDead();
    now += 59_000;
    expect(make().isDead()).toBe(true);
    now += 2_000;
    expect(make().isDead()).toBe(false);
  });

  it("keeps one memo per host", async () => {
    const dir = await tempDir();
    fileDeadLaneMemo("http://127.0.0.1:11435", { dir }).markDead();
    expect(fileDeadLaneMemo("http://127.0.0.1:11436", { dir }).isDead()).toBe(false);
  });
});

describe("InteractiveLaneClient", () => {
  function stub(model: string, result: number[][] | null, calls: string[], name: string): EmbeddingClient {
    return {
      model,
      dim: 4,
      async embed() {
        calls.push(name);
        return result;
      },
      async isAvailable() {
        return result !== null;
      },
    };
  }

  it("answers from the interactive client when it answers", async () => {
    const calls: string[] = [];
    const memo = memoryMemo();
    const lane = new InteractiveLaneClient(stub("m", [[1]], calls, "fast"), stub("m", [[2]], calls, "bulk"), memo);
    expect(await lane.embed(["q"])).toEqual([[1]]);
    expect(calls).toEqual(["fast"]);
    expect(memo.dead).toBe(false);
  });

  it("falls back once and marks the lane dead when the interactive client fails", async () => {
    const calls: string[] = [];
    const memo = memoryMemo();
    const lane = new InteractiveLaneClient(stub("m", null, calls, "fast"), stub("m", [[2]], calls, "bulk"), memo);
    expect(await lane.embed(["q"])).toEqual([[2]]);
    expect(calls).toEqual(["fast", "bulk"]);
    expect(memo.dead).toBe(true);

    expect(await lane.embed(["q"])).toEqual([[2]]);
    expect(calls).toEqual(["fast", "bulk", "bulk"]);
  });

  it("falls back when the interactive client throws", async () => {
    const memo = memoryMemo();
    const thrower: EmbeddingClient = {
      model: "m",
      dim: 4,
      embed: () => Promise.reject(new Error("boom")),
      isAvailable: async () => false,
    };
    const lane = new InteractiveLaneClient(thrower, stub("m", [[2]], [], "bulk"), memo);
    expect(await lane.embed(["q"])).toEqual([[2]]);
    expect(memo.dead).toBe(true);
  });

  it("carries the fallback's model and width", () => {
    const lane = new InteractiveLaneClient(stub("x", null, [], "a"), stub("qwen", null, [], "b"), memoryMemo());
    expect(lane.model).toBe("qwen");
    expect(lane.dim).toBe(4);
  });
});

describe("withLane", () => {
  const bulk = new OllamaEmbeddingClient("http://127.0.0.1:11434", undefined, "qwen3-embedding:0.6b", 1024);

  it("leaves bulk work on the caller's client", () => {
    expect(withLane(bulk, { lane: "bulk", interactiveHost: DEFAULT_INTERACTIVE_HOST })).toBe(bulk);
    expect(withLane(bulk, { interactiveHost: DEFAULT_INTERACTIVE_HOST })).toBe(bulk);
  });

  it("puts interactive work behind the interactive host", () => {
    const client = withLane(bulk, { lane: "interactive", interactiveHost: DEFAULT_INTERACTIVE_HOST, memo: memoryMemo(), warm: noWarm });
    expect(client).toBeInstanceOf(InteractiveLaneClient);
    expect(client.model).toBe(bulk.model);
    expect(client.dim).toBe(1024);
  });

  it("leaves the client alone when the lane is off or the client is lexical-only", () => {
    expect(withLane(bulk, { lane: "interactive", interactiveHost: null })).toBe(bulk);
    const none = new NullEmbeddingClient();
    expect(withLane(none, { lane: "interactive", interactiveHost: DEFAULT_INTERACTIVE_HOST })).toBe(none);
  });
});

describe("interactive lane against fake Ollama servers", () => {
  it("returns the vectors the default host would, from an identical request", async () => {
    const fast = fakeOllama();
    const slow = fakeOllama();
    const model = "qwen3-embedding:0.6b";
    const bulk = new OllamaEmbeddingClient(slow.host, undefined, model, 4);
    const lane = withLane(bulk, { lane: "interactive", interactiveHost: fast.host, memo: memoryMemo(), warm: noWarm });

    const texts = ["how does sync batch embeds", "second query"];
    const fromLane = await lane.embed(texts);
    const fromBulk = await bulk.embed(texts);

    expect(fromLane).toEqual(fromBulk);
    expect(fast.bodies).toEqual(slow.bodies);
    expect((fast.bodies[0] as { model: string }).model).toBe(model);
  });

  it("falls back to the default host when the interactive port refuses", async () => {
    const slow = fakeOllama();
    const memo = memoryMemo();
    const bulk = new OllamaEmbeddingClient(slow.host, undefined, "m", 4);
    const lane = withLane(bulk, { lane: "interactive", interactiveHost: await closedPortHost(), memo, warm: noWarm });

    expect(await lane.embed(["q"])).toEqual([vectorFor("m", "q")]);
    expect(slow.bodies).toHaveLength(1);
    expect(memo.dead).toBe(true);
  });

  it("asks a cold interactive host to load the model when it does not answer, and not when it does", async () => {
    const warmed: Array<[string, string]> = [];
    const warm = (host: string, model: string) => warmed.push([host, model]);
    const slow = fakeOllama();
    const bulk = new OllamaEmbeddingClient(slow.host, undefined, "m", 4);
    const closed = await closedPortHost();

    await withLane(bulk, { lane: "interactive", interactiveHost: closed, memo: memoryMemo(), warm }).embed(["q"]);
    expect(warmed).toEqual([[closed, "m"]]);

    const fast = fakeOllama();
    await withLane(bulk, { lane: "interactive", interactiveHost: fast.host, memo: memoryMemo(), warm }).embed(["q"]);
    expect(warmed).toHaveLength(1);
  });

  it("falls back within the budget when the interactive host hangs", async () => {
    const hung = fakeOllama({ delayMs: 3_000 });
    const slow = fakeOllama();
    const memo = memoryMemo();
    const bulk = new OllamaEmbeddingClient(slow.host, undefined, "m", 4);
    const lane = withLane(bulk, { lane: "interactive", interactiveHost: hung.host, memo, warm: noWarm });

    const start = performance.now();
    expect(await lane.embed(["q"])).toEqual([vectorFor("m", "q")]);
    expect(performance.now() - start).toBeLessThan(800);
    expect(memo.dead).toBe(true);
  });

  it("skips a host the memo says is dead without contacting it", async () => {
    const fast = fakeOllama();
    const slow = fakeOllama();
    const memo = memoryMemo();
    memo.dead = true;
    const lane = withLane(new OllamaEmbeddingClient(slow.host, undefined, "m", 4), {
      lane: "interactive",
      interactiveHost: fast.host,
      memo,
      warm: noWarm,
    });

    await lane.embed(["q"]);
    expect(fast.bodies).toHaveLength(0);
    expect(slow.bodies).toHaveLength(1);
  });

  it("uses the default host when the interactive one rejects the model", async () => {
    const fast = fakeOllama({ status: 404 });
    const slow = fakeOllama();
    const lane = withLane(new OllamaEmbeddingClient(slow.host, undefined, "m", 4), {
      lane: "interactive",
      interactiveHost: fast.host,
      memo: memoryMemo(),
      warm: noWarm,
    });
    expect(await lane.embed(["q"])).toEqual([vectorFor("m", "q")]);
  });
});

describe("createEmbeddingClient lane option", () => {
  it("routes interactive callers through the lane and leaves bulk callers as they were", async () => {
    const interactive = await createEmbeddingClient("qwen3-embedding", {
      host: "http://127.0.0.1:11434",
      recordedDim: 1024,
      lane: "interactive",
      interactiveHost: DEFAULT_INTERACTIVE_HOST,
      memo: memoryMemo(),
      warm: noWarm,
    });
    const bulk = await createEmbeddingClient("qwen3-embedding", { host: "http://127.0.0.1:11434", recordedDim: 1024 });

    expect(interactive).toBeInstanceOf(InteractiveLaneClient);
    expect(bulk).toBeInstanceOf(OllamaEmbeddingClient);
    expect(interactive.model).toBe(bulk.model);
    expect(interactive.dim).toBe(bulk.dim);
  });
});

describe("makeEmbeddingResolver lane option", () => {
  const defaultClient = new OllamaEmbeddingClient("http://127.0.0.1:11434", undefined, "default-model", 4);
  const readMeta = async () => ({ model: "other-model", dim: 8 }) as never;

  it("puts per-project clients behind the lane for an interactive resolver", async () => {
    const resolve = makeEmbeddingResolver({ dbPath: "/x", host: "http://127.0.0.1:11434", defaultClient, readMeta, lane: "interactive" });
    const client = await resolve("p");
    expect(client).toBeInstanceOf(InteractiveLaneClient);
    expect(client.model).toBe("other-model");
  });

  it("leaves per-project clients bare for a bulk resolver", async () => {
    const resolve = makeEmbeddingResolver({ dbPath: "/x", host: "http://127.0.0.1:11434", defaultClient, readMeta });
    expect(await resolve("p")).toBeInstanceOf(OllamaEmbeddingClient);
  });
});

describe("probeInteractiveLane", () => {
  it("reports off, up and down", async () => {
    expect(await probeInteractiveLane({ host: null })).toEqual({ status: "off" });
    const fake = fakeOllama();
    expect(await probeInteractiveLane({ host: fake.host })).toEqual({ status: "up", host: fake.host });
    const closed = await closedPortHost();
    expect(await probeInteractiveLane({ host: closed })).toEqual({ status: "down", host: closed });
  });
});

describe("caller routing", () => {
  const root = join(import.meta.dir, "..", "..", "src");
  const interactiveCallers = ["commands/suggest.ts", "commands/search.ts"];
  const bulkCallers = [
    "commands/sync.ts",
    "commands/init.ts",
    "commands/reindex.ts",
    "commands/okf.ts",
    "commands/conceptualize.ts",
    "commands/tool-catalog.ts",
    "commands/health.ts",
    "commands/bench.ts",
  ];

  it("names the interactive lane in every prompt-time embed", async () => {
    for (const file of interactiveCallers) {
      const source = await readFile(join(root, file), "utf-8");
      expect(source).toMatch(/createEmbeddingClient\([^;]*lane: "interactive"/s);
    }
  });

  it("never names it in indexing or cache-building callers", async () => {
    for (const file of bulkCallers) {
      expect(await readFile(join(root, file), "utf-8")).not.toContain('lane: "interactive"');
    }
  });

  it("gives the MCP server's search its own query resolver", async () => {
    const search = await readFile(join(root, "tools/search.ts"), "utf-8");
    expect(search).toContain("deps.queryEmbeddingsFor ?? deps.embeddingsFor");
    for (const file of ["tools/sync-project.ts", "tools/ingest.ts", "watcher.ts"]) {
      expect(await readFile(join(root, file), "utf-8")).not.toContain("queryEmbeddingsFor");
    }
  });
});
