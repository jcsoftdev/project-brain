import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_INTERACTIVE_HOST,
  INTERACTIVE_HOST_ENV,
  InteractiveLaneClient,
  LANE_VERDICT_TTL_MS,
  fileLaneMemo,
  probeInteractiveLane,
  resolveInteractiveHost,
  verifyLane,
  withLane,
  type LaneMemo,
  type LaneState,
  type LaneVerdict,
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
  embedBodies: Array<{ model: string; input: string[] }>;
}

interface FakeOptions {
  delayMs?: number;
  status?: number;
  version?: string;
  digest?: string;
  skew?: number;
  models?: string[];
}

function vectorFor(model: string, text: string, skew = 0): number[] {
  const seed = [...`${model}|${text}`].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 9973, 7);
  return [seed / 9973 + skew, (seed % 97) / 97, (seed % 13) / 13, 1];
}

function fakeOllama(opts: FakeOptions = {}): FakeOllama {
  const embedBodies: FakeOllama["embedBodies"] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/version") return Response.json({ version: opts.version ?? "0.40.14" });
      if (path === "/api/tags") {
        const names = opts.models ?? ["m", "qwen3-embedding:0.6b"];
        return Response.json({ models: names.map((name) => ({ name, digest: opts.digest ?? "sha-1" })) });
      }
      const body = (await req.json()) as { model: string; input: string[] };
      embedBodies.push(body);
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      if (opts.status) return new Response("nope", { status: opts.status });
      return Response.json({ embeddings: body.input.map((t) => vectorFor(body.model, t, opts.skew)) });
    },
  });
  servers.push(server);
  return { host: `http://127.0.0.1:${server.port}`, embedBodies };
}

function memoryMemo(state?: LaneState): LaneMemo & { verdict: LaneVerdict | null; writes: LaneState[] } {
  return {
    verdict: state ? { state, at: Date.now() } : null,
    writes: [],
    read() {
      return this.verdict;
    },
    write(next, reason) {
      this.writes.push(next);
      this.verdict = { state: next, at: Date.now(), ...(reason ? { reason } : {}) };
    },
  };
}

const noVerify = () => {};

async function closedPortHost(): Promise<string> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const host = `http://127.0.0.1:${probe.port}`;
  probe.stop(true);
  return host;
}

describe("resolveInteractiveHost", () => {
  it("is off until setup or the env var turns it on", () => {
    expect(resolveInteractiveHost({ env: {} })).toBeNull();
  });

  it("takes the env override and strips a trailing slash", () => {
    expect(resolveInteractiveHost({ env: { [INTERACTIVE_HOST_ENV]: "http://10.0.0.5:9999/" } })).toBe("http://10.0.0.5:9999");
  });

  it("turns the lane off with `off` from env, even when configured", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "ollama.json");
    await writeFile(configPath, JSON.stringify({ interactiveHost: DEFAULT_INTERACTIVE_HOST }));
    expect(resolveInteractiveHost({ env: { [INTERACTIVE_HOST_ENV]: "OFF" }, configPath })).toBeNull();
  });

  it("reads the config file setup writes, and env beats it", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "ollama.json");
    await writeFile(configPath, JSON.stringify({ interactiveHost: "http://127.0.0.1:12000" }));
    expect(resolveInteractiveHost({ env: {}, configPath })).toBe("http://127.0.0.1:12000");
    expect(resolveInteractiveHost({ env: { [INTERACTIVE_HOST_ENV]: "http://127.0.0.1:13000" }, configPath })).toBe(
      "http://127.0.0.1:13000"
    );
  });

  it("stays off with a blank env value and an unreadable config", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "ollama.json");
    await writeFile(configPath, "{not json");
    expect(resolveInteractiveHost({ env: { [INTERACTIVE_HOST_ENV]: "  " }, configPath })).toBeNull();
  });
});

describe("fileLaneMemo", () => {
  it("keeps each verdict for its own TTL, across memo instances", async () => {
    const dir = await tempDir();
    let now = 1_000_000;
    const make = () => fileLaneMemo("http://127.0.0.1:11435", "m", { dir, now: () => now });

    expect(make().read()).toBeNull();
    make().write("dead");
    now += LANE_VERDICT_TTL_MS.dead - 1;
    expect(make().read()?.state).toBe("dead");
    now += 2;
    expect(make().read()).toBeNull();

    make().write("ok");
    now += LANE_VERDICT_TTL_MS.dead + 1;
    expect(make().read()?.state).toBe("ok");
  });

  it("ignores a verdict stamped in the future", async () => {
    const dir = await tempDir();
    fileLaneMemo("h", "m", { dir, now: () => 5_000 }).write("ok");
    expect(fileLaneMemo("h", "m", { dir, now: () => 1_000 }).read()).toBeNull();
  });

  it("keys verdicts by host and model", async () => {
    const dir = await tempDir();
    fileLaneMemo("http://127.0.0.1:11435", "a", { dir }).write("ok");
    expect(fileLaneMemo("http://127.0.0.1:11435", "b", { dir }).read()).toBeNull();
    expect(fileLaneMemo("http://127.0.0.1:11436", "a", { dir }).read()).toBeNull();
  });
});

describe("InteractiveLaneClient", () => {
  function stub(result: number[][] | null, calls: string[], name: string): EmbeddingClient {
    return {
      model: "m",
      dim: 4,
      async embed(texts) {
        calls.push(`${name}:${texts.length}`);
        return result;
      },
      async isAvailable() {
        return result !== null;
      },
    };
  }

  it("answers from a verified lane", async () => {
    const calls: string[] = [];
    const lane = new InteractiveLaneClient(stub([[1]], calls, "lane"), stub([[2]], calls, "bulk"), memoryMemo("ok"));
    expect(await lane.embed(["q"])).toEqual([[1]]);
    expect(calls).toEqual(["lane:1"]);
  });

  it("never sends a batch through the lane, nor touches the memo for one", async () => {
    const calls: string[] = [];
    const memo = memoryMemo("ok");
    let verified = 0;
    const lane = new InteractiveLaneClient(stub([[1]], calls, "lane"), stub([[2]], calls, "bulk"), memo, () => verified++);
    await lane.embed(Array.from({ length: 16 }, (_, i) => `skill ${i}`));
    expect(calls).toEqual(["bulk:16"]);
    expect(memo.writes).toEqual([]);
    expect(verified).toBe(0);

    memo.verdict = null;
    await lane.embed(["a", "b"]);
    expect(memo.writes).toEqual([]);
    expect(verified).toBe(0);
  });

  it("does not trust an unverified lane: falls back, marks pending, starts one verification", async () => {
    const calls: string[] = [];
    const memo = memoryMemo();
    let verified = 0;
    const lane = new InteractiveLaneClient(stub([[1]], calls, "lane"), stub([[2]], calls, "bulk"), memo, () => verified++);

    expect(await lane.embed(["q"])).toEqual([[2]]);
    expect(await lane.embed(["q"])).toEqual([[2]]);
    expect(calls).toEqual(["bulk:1", "bulk:1"]);
    expect(memo.writes).toEqual(["pending"]);
    expect(verified).toBe(1);
  });

  it("skips a lane recorded as mismatched or dead", async () => {
    for (const state of ["mismatch", "dead"] as const) {
      const calls: string[] = [];
      const lane = new InteractiveLaneClient(stub([[1]], calls, "lane"), stub([[2]], calls, "bulk"), memoryMemo(state), noVerify);
      expect(await lane.embed(["q"])).toEqual([[2]]);
      expect(calls).toEqual(["bulk:1"]);
    }
  });

  it("marks a verified lane dead when it stops answering, and falls back once", async () => {
    const calls: string[] = [];
    const memo = memoryMemo("ok");
    const lane = new InteractiveLaneClient(stub(null, calls, "lane"), stub([[2]], calls, "bulk"), memo, noVerify);
    expect(await lane.embed(["q"])).toEqual([[2]]);
    expect(memo.verdict?.state).toBe("dead");
    expect(await lane.embed(["q"])).toEqual([[2]]);
    expect(calls).toEqual(["lane:1", "bulk:1", "bulk:1"]);
  });

  it("falls back when the lane throws", async () => {
    const memo = memoryMemo("ok");
    const thrower: EmbeddingClient = { model: "m", dim: 4, embed: () => Promise.reject(new Error("boom")), isAvailable: async () => false };
    const lane = new InteractiveLaneClient(thrower, stub([[2]], [], "bulk"), memo, noVerify);
    expect(await lane.embed(["q"])).toEqual([[2]]);
    expect(memo.verdict?.state).toBe("dead");
  });
});

describe("verifyLane", () => {
  it("accepts a lane with the same version, digest and probe vector", async () => {
    const lane = fakeOllama();
    const def = fakeOllama();
    expect(await verifyLane({ host: lane.host, fallbackHost: def.host, model: "m" })).toEqual({ state: "ok" });
    expect(lane.embedBodies).toEqual(def.embedBodies);
  });

  it("rejects version skew, a different digest, a missing model and a different vector", async () => {
    const def = fakeOllama();
    const cases: Array<[FakeOptions, RegExp]> = [
      [{ version: "0.41.0" }, /ollama 0\.41\.0 on the lane/],
      [{ digest: "sha-2" }, /digest differs/],
      [{ models: ["other"] }, /not installed on the lane/],
      [{ skew: 1e-6 }, /probe embedding differs/],
    ];
    for (const [opts, reason] of cases) {
      const lane = fakeOllama(opts);
      const verdict = await verifyLane({ host: lane.host, fallbackHost: def.host, model: "m" });
      expect(verdict.state).toBe("mismatch");
      expect(verdict.reason).toMatch(reason);
    }
  });

  it("calls a lane nobody answers on dead, and a foreign process that is not Ollama dead too", async () => {
    const def = fakeOllama();
    expect((await verifyLane({ host: await closedPortHost(), fallbackHost: def.host, model: "m" })).state).toBe("dead");
    const foreign = Bun.serve({ port: 0, fetch: () => new Response("hello", { status: 404 }) });
    servers.push(foreign);
    expect((await verifyLane({ host: `http://127.0.0.1:${foreign.port}`, fallbackHost: def.host, model: "m" })).state).toBe("dead");
  });
});

describe("withLane", () => {
  const bulk = new OllamaEmbeddingClient("http://127.0.0.1:11434", undefined, "qwen3-embedding:0.6b", 1024);

  it("leaves bulk work on the caller's client", () => {
    expect(withLane(bulk, { lane: "bulk", interactiveHost: DEFAULT_INTERACTIVE_HOST })).toBe(bulk);
    expect(withLane(bulk, { interactiveHost: DEFAULT_INTERACTIVE_HOST })).toBe(bulk);
  });

  it("puts interactive work behind the interactive host", () => {
    const client = withLane(bulk, { lane: "interactive", interactiveHost: DEFAULT_INTERACTIVE_HOST, memo: memoryMemo(), verify: noVerify });
    expect(client).toBeInstanceOf(InteractiveLaneClient);
    expect(client.model).toBe(bulk.model);
    expect(client.dim).toBe(1024);
  });

  it("leaves the client alone when the lane is off or the client is lexical-only", () => {
    expect(withLane(bulk, { lane: "interactive", interactiveHost: null })).toBe(bulk);
    const none = new NullEmbeddingClient();
    expect(withLane(none, { lane: "interactive", interactiveHost: DEFAULT_INTERACTIVE_HOST })).toBe(none);
  });

  it("verifies against the caller's own host and model", async () => {
    const seen: string[][] = [];
    const slow = fakeOllama();
    const lane = withLane(new OllamaEmbeddingClient(slow.host, undefined, "m", 4), {
      lane: "interactive",
      interactiveHost: "http://127.0.0.1:1",
      fallbackHost: slow.host,
      memo: memoryMemo(),
      verify: (...args) => seen.push(args),
    });
    await lane.embed(["q"]);
    expect(seen).toEqual([["http://127.0.0.1:1", slow.host, "m"]]);
  });
});

describe("interactive lane against fake Ollama servers", () => {
  it("returns the vectors the default host would, from an identical request", async () => {
    const fast = fakeOllama();
    const slow = fakeOllama();
    const model = "qwen3-embedding:0.6b";
    const bulk = new OllamaEmbeddingClient(slow.host, undefined, model, 4);
    const lane = withLane(bulk, { lane: "interactive", interactiveHost: fast.host, memo: memoryMemo("ok"), verify: noVerify });

    const fromLane = await lane.embed(["how does sync batch embeds"]);
    const fromBulk = await bulk.embed(["how does sync batch embeds"]);

    expect(fromLane).toEqual(fromBulk);
    expect(fast.embedBodies).toEqual(slow.embedBodies);
    expect(fast.embedBodies[0]!.model).toBe(model);
  });

  it("falls back to the default host when the interactive port refuses", async () => {
    const slow = fakeOllama();
    const memo = memoryMemo("ok");
    const bulk = new OllamaEmbeddingClient(slow.host, undefined, "m", 4);
    const lane = withLane(bulk, { lane: "interactive", interactiveHost: await closedPortHost(), memo, verify: noVerify });

    expect(await lane.embed(["q"])).toEqual([vectorFor("m", "q")]);
    expect(slow.embedBodies).toHaveLength(1);
    expect(memo.verdict?.state).toBe("dead");
  });

  it("falls back within the budget when the interactive host hangs", async () => {
    const hung = fakeOllama({ delayMs: 3_000 });
    const slow = fakeOllama();
    const memo = memoryMemo("ok");
    const bulk = new OllamaEmbeddingClient(slow.host, undefined, "m", 4);
    const lane = withLane(bulk, { lane: "interactive", interactiveHost: hung.host, memo, verify: noVerify });

    const start = performance.now();
    expect(await lane.embed(["q"])).toEqual([vectorFor("m", "q")]);
    expect(performance.now() - start).toBeLessThan(800);
    expect(memo.verdict?.state).toBe("dead");
  });

  it("sends a 16-text skill batch to the default host only", async () => {
    const fast = fakeOllama();
    const slow = fakeOllama();
    const memo = memoryMemo("ok");
    const lane = withLane(new OllamaEmbeddingClient(slow.host, undefined, "m", 4), {
      lane: "interactive",
      interactiveHost: fast.host,
      memo,
      verify: noVerify,
    });
    await lane.embed(Array.from({ length: 16 }, (_, i) => `skill ${i}`));
    expect(fast.embedBodies).toHaveLength(0);
    expect(slow.embedBodies).toHaveLength(1);
    expect(memo.writes).toEqual([]);
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
      verify: noVerify,
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
    const previous = process.env[INTERACTIVE_HOST_ENV];
    process.env[INTERACTIVE_HOST_ENV] = DEFAULT_INTERACTIVE_HOST;
    try {
      const resolve = makeEmbeddingResolver({ dbPath: "/x", host: "http://127.0.0.1:11434", defaultClient, readMeta, lane: "interactive" });
      const client = await resolve("p");
      expect(client).toBeInstanceOf(InteractiveLaneClient);
      expect(client.model).toBe("other-model");
    } finally {
      if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
      else process.env[INTERACTIVE_HOST_ENV] = previous;
    }
  });

  it("leaves per-project clients bare for a bulk resolver", async () => {
    const resolve = makeEmbeddingResolver({ dbPath: "/x", host: "http://127.0.0.1:11434", defaultClient, readMeta });
    expect(await resolve("p")).toBeInstanceOf(OllamaEmbeddingClient);
  });
});

describe("probeInteractiveLane", () => {
  it("reports off, up, down and mismatch, and records the verdict", async () => {
    const def = fakeOllama();
    expect(await probeInteractiveLane({ model: "m", host: null })).toEqual({ status: "off" });

    const same = fakeOllama();
    const memo = memoryMemo();
    expect(await probeInteractiveLane({ model: "m", host: same.host, fallbackHost: def.host, memo })).toEqual({
      status: "up",
      host: same.host,
    });
    expect(memo.verdict?.state).toBe("ok");

    const closed = await closedPortHost();
    expect((await probeInteractiveLane({ model: "m", host: closed, fallbackHost: def.host, memo: memoryMemo() })).status).toBe("down");

    const skewed = fakeOllama({ skew: 0.001 });
    const mismatch = await probeInteractiveLane({ model: "m", host: skewed.host, fallbackHost: def.host, memo: memoryMemo() });
    expect(mismatch.status).toBe("mismatch");
    expect(mismatch.reason).toMatch(/probe embedding differs/);
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
