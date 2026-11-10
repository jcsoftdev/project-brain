import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chunk, EmbeddingClient, SearchResult, VectorStore } from "../../src/types.js";
import { execute as searchExecute, runSearch } from "../../src/commands/search.js";
import { runSuggest } from "../../src/commands/suggest.js";
import { liveHookOutput } from "../../src/hooks/injected.js";

function hit(n: number, over: Partial<SearchResult> = {}): SearchResult {
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
    ...over,
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

/** A Claude Code transcript: one JSON object per line, linked by parentUuid. */
class Transcript {
  private last: string | null = null;
  private n = 0;
  constructor(readonly path: string) {}

  async add(entry: Record<string, unknown>, parent: string | null = this.last): Promise<string> {
    const uuid = `u-${++this.n}`;
    await appendFile(this.path, `${JSON.stringify({ parentUuid: parent, isSidechain: false, ...entry, uuid })}\n`);
    this.last = uuid;
    return uuid;
  }
  prompt = (text: string, parent?: string | null) => this.add({ type: "user", message: { role: "user", content: text } }, parent);
  hookOutput = (stdout: string) =>
    this.add({ type: "attachment", attachment: { type: "hook_success", hookName: "UserPromptSubmit", hookEvent: "UserPromptSubmit", content: stdout, stdout, exitCode: 0 } });
  additionalContext = (content: string) =>
    this.add({ type: "attachment", attachment: { type: "hook_additional_context", hookName: "UserPromptSubmit", hookEvent: "UserPromptSubmit", content: [content] } });
  reply = () => this.add({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
  compact = () => this.add({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" }, null);
}

let dir: string;
let printed: string[];
const realLog = console.log;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-dedup-"));
  printed = [];
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  delete process.env.PROJECT_BRAIN_CONTEXT_DEDUP;
});

afterEach(async () => {
  console.log = realLog;
  delete process.env.PROJECT_BRAIN_CONTEXT_DEDUP;
  await rm(dir, { recursive: true, force: true });
});

const QUERY = "how do handlers compute";

/** One search hook invocation against the transcript as it stands; returns what it printed. */
async function search(t: Transcript | null, results: SearchResult[]): Promise<string> {
  printed = [];
  await runSearch({ query: QUERY, project: "p", limit: 8 }, { store: store(results), embeddings, alreadyShown: liveHookOutput(t?.path) });
  return printed.join("\n");
}

/** A full turn: the prompt lands, the hook runs, its output is recorded the way Claude Code records it. */
async function turn(t: Transcript, results: SearchResult[]): Promise<string> {
  await t.prompt(QUERY);
  const out = await search(t, results);
  if (out) await t.hookOutput(out);
  await t.reply();
  return out;
}

const sources = (out: string) => out.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.split(" ")[1]);

describe("search hook dedup", () => {
  it("injects on the first prompt and nothing on an identical second one", async () => {
    const t = new Transcript(join(dir, "s1.jsonl"));
    expect(sources(await turn(t, [hit(1), hit(2)]))).toEqual(["src/area1/file1.ts", "src/area2/file2.ts"]);
    expect(await turn(t, [hit(1), hit(2)])).toBe("");
  });

  it("injects only the new items of a partially new result", async () => {
    const t = new Transcript(join(dir, "s1.jsonl"));
    await turn(t, [hit(1), hit(2)]);
    const second = await turn(t, [hit(1), hit(2), hit(3)]);
    expect(sources(second)).toEqual(["src/area3/file3.ts"]);
    expect(second.startsWith("<project-brain: relevant context for this prompt>\n")).toBe(true);
    expect(second.endsWith("\n</project-brain>")).toBe(true);
  });

  it("keeps sessions independent", async () => {
    await turn(new Transcript(join(dir, "s1.jsonl")), [hit(1)]);
    expect(sources(await turn(new Transcript(join(dir, "s2.jsonl")), [hit(1)]))).toEqual(["src/area1/file1.ts"]);
  });

  it("injects again after a compaction", async () => {
    const t = new Transcript(join(dir, "s1.jsonl"));
    await turn(t, [hit(1)]);
    await t.compact();
    expect(sources(await turn(t, [hit(1)]))).toEqual(["src/area1/file1.ts"]);
  });

  it("injects again after a rewind past the prompt that carried it", async () => {
    const t = new Transcript(join(dir, "s1.jsonl"));
    const root = await t.prompt("start");
    await t.reply();
    await turn(t, [hit(1)]);
    await t.prompt(QUERY, root);
    expect(sources(await search(t, [hit(1)]))).toEqual(["src/area1/file1.ts"]);
  });

  it("injects normally when the transcript is missing or unparseable", async () => {
    expect(sources(await search(new Transcript(join(dir, "missing.jsonl")), [hit(1)]))).toEqual(["src/area1/file1.ts"]);
    const garbage = new Transcript(join(dir, "garbage.jsonl"));
    await writeFile(garbage.path, "{not json\n\u0000\u0001\n");
    expect(sources(await search(garbage, [hit(1)]))).toEqual(["src/area1/file1.ts"]);
    expect(sources(await search(null, [hit(1)]))).toEqual(["src/area1/file1.ts"]);
  });

  it("is off with PROJECT_BRAIN_CONTEXT_DEDUP=0", async () => {
    process.env.PROJECT_BRAIN_CONTEXT_DEDUP = "0";
    const t = new Transcript(join(dir, "s1.jsonl"));
    await turn(t, [hit(1)]);
    expect(sources(await turn(t, [hit(1)]))).toEqual(["src/area1/file1.ts"]);
  });

  it("tells apart two chunks with the same source and range", async () => {
    const t = new Transcript(join(dir, "s1.jsonl"));
    const a = hit(1, { id: "readme-a", content: "### `search`\nSearch the indexed context." });
    const b = hit(1, { id: "readme-b", content: "| Variable | Default |\n|---|---|" });
    await turn(t, [a]);
    expect(await turn(t, [a, b])).toContain("| Variable | Default |");
    expect(await turn(t, [a, b])).toBe("");
  });

  it("injects a snippet again when its text changed but its range did not", async () => {
    const t = new Transcript(join(dir, "s1.jsonl"));
    await turn(t, [hit(1)]);
    expect(await turn(t, [hit(1, { content: "export function handler1(input) {\n  return renamed(input);" })])).toContain("renamed(input)");
  });

  it("does not inject a snippet again only because its score changed", async () => {
    const t = new Transcript(join(dir, "s1.jsonl"));
    await t.prompt(QUERY);
    await t.hookOutput(
      "<project-brain: relevant context for this prompt>\n- src/area1/file1.ts › handler1 (L10-15) [score 0.12]\n  export function handler1(input) {\n  return compute1(input);\n</project-brain>"
    );
    await t.reply();
    expect(await turn(t, [hit(1)])).toBe("");
  });

  it("prints a first injection byte-identical to the output without dedup", async () => {
    await runSearch({ query: QUERY, project: "p", limit: 8 }, { store: store([hit(1), hit(2)]), embeddings });
    const plain = printed.join("\n");
    expect(plain).not.toBe("");
    expect(await turn(new Transcript(join(dir, "s1.jsonl")), [hit(1), hit(2)])).toBe(plain);
  });

  it("execute --stdin reads transcript_path and dedups against it", async () => {
    const t = new Transcript(join(dir, "s1.jsonl"));
    const first = await turn(t, [hit(1)]);
    await t.prompt(QUERY);
    const payload = JSON.stringify({ session_id: "s1", transcript_path: t.path, prompt: QUERY, hook_event_name: "UserPromptSubmit" });
    const run = async (raw: string) => {
      printed = [];
      await searchExecute(["--stdin"], async () => raw, (query, alreadyShown) =>
        runSearch({ query, project: "p", limit: 8 }, { store: store([hit(1)]), embeddings, alreadyShown })
      );
      return printed.join("\n");
    };
    expect(await run(payload)).toBe("");
    expect(await run(JSON.stringify({ session_id: "s1", prompt: QUERY }))).toBe(first);
  });
});

describe("liveHookOutput", () => {
  it("reads only the transcript tail, so an injection older than the bound is shown again", async () => {
    const t = new Transcript(join(dir, "s1.jsonl"));
    await t.prompt(QUERY);
    await t.hookOutput("Suggested skill: old — x");
    for (let i = 0; i < 20; i++) await t.reply();
    expect(await liveHookOutput(t.path)).toContain("Suggested skill: old");
    expect(await liveHookOutput(t.path, 1500)).toBe("");
  });
});

describe("suggest hook dedup", () => {
  const suggest = async (t: Transcript, lines: string[]) => {
    await t.prompt("haz el commit de estos cambios");
    const out: string[] = [];
    await runSuggest(JSON.stringify({ prompt: "haz el commit de estos cambios", cwd: "/x", session_id: "s1", transcript_path: t.path }), {
      print: (l) => out.push(l),
      queryEmbedding: async () => null,
      taskContext: async () => null,
      upgradeNotice: async () => null,
      pick: async () => lines,
    });
    if (out.length) await t.hookOutput(out.join("\n"));
    await t.reply();
    return out;
  };

  it("suggests a skill or tool once, even when Jev rewords its description", async () => {
    const t = new Transcript(join(dir, "s1.jsonl"));
    expect(await suggest(t, ["Suggested skill: brain-commit — writes commits"])).toEqual(["Suggested skill: brain-commit — writes commits"]);
    expect(await suggest(t, ["Suggested skill: brain-commit — commit writer", "Suggested tool: mcp__x__y — does y"])).toEqual([
      "Suggested tool: mcp__x__y — does y",
    ]);
    expect(await suggest(new Transcript(join(dir, "s2.jsonl")), ["Suggested skill: brain-commit — writes commits"])).toHaveLength(1);
  });

  it("recognises a suggestion delivered as additionalContext", async () => {
    const t = new Transcript(join(dir, "s1.jsonl"));
    await t.prompt("x");
    await t.additionalContext("Suggested skill: a — b");
    expect(await suggest(t, ["Suggested skill: a — b"])).toEqual([]);
  });

  it("suggests again after a compaction", async () => {
    const t = new Transcript(join(dir, "s1.jsonl"));
    await suggest(t, ["Suggested skill: a — b"]);
    await t.compact();
    expect(await suggest(t, ["Suggested skill: a — b"])).toEqual(["Suggested skill: a — b"]);
  });

  it("suggests every time with PROJECT_BRAIN_CONTEXT_DEDUP=0", async () => {
    process.env.PROJECT_BRAIN_CONTEXT_DEDUP = "0";
    const t = new Transcript(join(dir, "s1.jsonl"));
    await suggest(t, ["Suggested skill: a — b"]);
    expect(await suggest(t, ["Suggested skill: a — b"])).toEqual(["Suggested skill: a — b"]);
  });
});
