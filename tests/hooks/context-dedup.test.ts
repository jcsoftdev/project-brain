import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chunk, EmbeddingClient, SearchResult, VectorStore } from "../../src/types.js";
import { runSearch } from "../../src/commands/search.js";
import { runSuggest } from "../../src/commands/suggest.js";
import { execute as routingRules } from "../../src/hooks/routing-rules.js";
import { openLedger } from "../../src/hooks/injected.js";
import { recordSession } from "../../src/hooks/session-versions.js";

function hit(n: number): SearchResult {
  return {
    id: `chunk-${n}`,
    content: `export function handler${n}(input) {\n  return compute${n}(input);\n}`,
    source: `src/area${n}/file${n}.ts`,
    module: "src",
    score: 0.9 - n * 0.01,
    symbol_name: `handler${n}`,
    symbol_kind: "function",
    start_line: n * 10,
    end_line: n * 10 + 5,
  };
}

function store(results: SearchResult[]): VectorStore {
  return {
    ensureTable: async () => {},
    upsert: async () => {},
    search: async () => results,
    deleteBySource: async () => {},
    listModules: async () => [],
    getModuleChunks: async (): Promise<Chunk[]> => [],
    countChunks: async () => 0,
    optimize: async () => {},
    batchReplace: async () => {},
    buildIndexes: async () => {},
    hybridSearch: async () => results,
    getChunkById: async () => null,
    assertDim: async () => {},
  };
}

const embeddings: EmbeddingClient = {
  dim: 8,
  model: "dedup-test-model",
  embed: async (texts: string[]) => texts.map(() => Array(8).fill(0.1)),
  isAvailable: async () => true,
};

let dataDir: string;
let printed: string[];
const realLog = console.log;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pb-dedup-"));
  printed = [];
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  delete process.env.PROJECT_BRAIN_CONTEXT_DEDUP;
});

afterEach(async () => {
  console.log = realLog;
  delete process.env.PROJECT_BRAIN_CONTEXT_DEDUP;
  await rm(dataDir, { recursive: true, force: true });
});

const startSession = (id: string, source = "startup") => recordSession(dataDir, id, "1.0.0", Date.now(), source);
const sessionStart = (sessionId: string, source: string) => routingRules(async () => {}, async () => ({ sessionId, source }), dataDir);

/** One search hook invocation; returns what it printed. */
async function search(sessionId: string, results: SearchResult[]): Promise<string> {
  printed = [];
  const ledger = await openLedger(dataDir, sessionId, "search");
  await runSearch({ query: "how do handlers compute", project: "p", limit: 8 }, { store: store(results), embeddings, ledger });
  return printed.join("\n");
}

const sources = (out: string) => out.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.split(" ")[1]);

describe("search hook dedup", () => {
  it("injects on the first prompt and nothing on an identical second one", async () => {
    await startSession("s1");
    expect(sources(await search("s1", [hit(1), hit(2)]))).toEqual(["src/area1/file1.ts", "src/area2/file2.ts"]);
    expect(await search("s1", [hit(1), hit(2)])).toBe("");
  });

  it("injects only the new items of a partially new result", async () => {
    await startSession("s1");
    await search("s1", [hit(1), hit(2)]);
    const second = await search("s1", [hit(1), hit(2), hit(3)]);
    expect(sources(second)).toEqual(["src/area3/file3.ts"]);
    expect(second.startsWith("<project-brain: relevant context for this prompt>")).toBe(true);
  });

  it("keeps sessions independent", async () => {
    await startSession("s1");
    await startSession("s2");
    await search("s1", [hit(1)]);
    expect(sources(await search("s2", [hit(1)]))).toEqual(["src/area1/file1.ts"]);
  });

  it("re-allows everything after a compaction", async () => {
    await startSession("s1");
    await search("s1", [hit(1)]);
    await sessionStart("s1", "compact");
    expect(sources(await search("s1", [hit(1)]))).toEqual(["src/area1/file1.ts"]);
  });

  it("keeps the memory across a resume", async () => {
    await startSession("s1");
    await search("s1", [hit(1)]);
    await sessionStart("s1", "resume");
    expect(await search("s1", [hit(1)])).toBe("");
  });

  it("injects normally when the state file is corrupt, and repairs it", async () => {
    await startSession("s1");
    await writeFile(join(dataDir, "sessions", "s1.search-injected.json"), "{not json");
    expect(sources(await search("s1", [hit(1)]))).toEqual(["src/area1/file1.ts"]);
    expect(await search("s1", [hit(1)])).toBe("");
  });

  it("is off with PROJECT_BRAIN_CONTEXT_DEDUP=0", async () => {
    process.env.PROJECT_BRAIN_CONTEXT_DEDUP = "0";
    await startSession("s1");
    await search("s1", [hit(1)]);
    expect(sources(await search("s1", [hit(1)]))).toEqual(["src/area1/file1.ts"]);
    expect(await readdir(join(dataDir, "sessions"))).not.toContain("s1.search-injected.json");
  });

  it("does not dedup a session the SessionStart hook never recorded, since nothing would reset it", async () => {
    await search("unknown", [hit(1)]);
    expect(sources(await search("unknown", [hit(1)]))).toEqual(["src/area1/file1.ts"]);
  });

  it("prints a first injection byte-identical to the output without dedup", async () => {
    await startSession("s1");
    printed = [];
    await runSearch({ query: "how do handlers compute", project: "p", limit: 8 }, { store: store([hit(1), hit(2)]), embeddings });
    const plain = printed.join("\n");
    expect(plain).not.toBe("");
    expect(await search("s1", [hit(1), hit(2)])).toBe(plain);
  });
});

describe("suggest hook dedup", () => {
  const payload = (sessionId: string) => JSON.stringify({ prompt: "haz el commit de estos cambios", cwd: "/x", session_id: sessionId });
  const suggest = async (sessionId: string, lines: string[]) => {
    const out: string[] = [];
    await runSuggest(payload(sessionId), {
      dataDir,
      print: (l) => out.push(l),
      queryEmbedding: async () => null,
      taskContext: async () => null,
      upgradeNotice: async () => null,
      pick: async () => lines,
    });
    return out;
  };

  it("suggests a skill or tool once per session, even when Jev rewords its description", async () => {
    await startSession("s1");
    await startSession("s2");
    expect(await suggest("s1", ["Suggested skill: brain-commit — writes commits"])).toEqual(["Suggested skill: brain-commit — writes commits"]);
    expect(await suggest("s1", ["Suggested skill: brain-commit — commit writer", "Suggested tool: mcp__x__y — does y"])).toEqual([
      "Suggested tool: mcp__x__y — does y",
    ]);
    expect(await suggest("s2", ["Suggested skill: brain-commit — writes commits"])).toHaveLength(1);
  });

  it("suggests again after /clear", async () => {
    await startSession("s1");
    await suggest("s1", ["Suggested skill: a — b"]);
    await sessionStart("s1", "clear");
    expect(await suggest("s1", ["Suggested skill: a — b"])).toEqual(["Suggested skill: a — b"]);
  });

  it("suggests every time with PROJECT_BRAIN_CONTEXT_DEDUP=0", async () => {
    process.env.PROJECT_BRAIN_CONTEXT_DEDUP = "0";
    await startSession("s1");
    await suggest("s1", ["Suggested skill: a — b"]);
    expect(await suggest("s1", ["Suggested skill: a — b"])).toEqual(["Suggested skill: a — b"]);
  });
});
