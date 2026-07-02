import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WasmParser } from "../../src/parser/wasm.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

/** Minimal no-op in-memory store (mirrors pattern in sync.test.ts). */
function makeMemoryStore(): VectorStore {
  const data = new Map<string, Chunk[]>();
  return {
    data,
    ensureTable: async () => {},
    upsert: async () => {},
    search: async (): Promise<SearchResult[]> => [],
    deleteBySource: async (project, source) => {
      const existing = data.get(project) ?? [];
      data.set(project, existing.filter((c) => c.source !== source));
    },
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async () => 0,
    optimize: async () => {},
    batchReplace: async (project, sources, chunks) => {
      const existing = (data.get(project) ?? []).filter((c) => !sources.includes(c.source));
      data.set(project, [...existing, ...chunks]);
    },
    buildIndexes: async () => {},
    hybridSearch: async (): Promise<SearchResult[]> => [],
    getChunkById: async () => null,
    assertDim: async () => {},
  } as any;
}

/** No-op embedding client — returns zero vectors, no Ollama needed. */
const noopEmbeddings: EmbeddingClient = {
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.0)),
  isAvailable: async () => true,
};

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "brain-graph-"));
  mkdirSync(join(tempDir, ".project-brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("runSync populates graph symbols for changed TypeScript files", async () => {
  writeFileSync(
    join(tempDir, "a.ts"),
    "export function add(a: number, b: number){ return a + b; }"
  );

  const { runSync } = await import("../../src/commands/sync.js");
  const { openGraphDb } = await import("../../src/graph/db.js");

  await runSync({
    root: tempDir,
    projectId: "test-graph",
    store: makeMemoryStore(),
    embeddings: noopEmbeddings,
  });

  const db = openGraphDb(join(tempDir, ".project-brain", "graph.db"));
  const rows = db.query("SELECT name FROM symbols").all() as { name: string }[];
  db.close();

  expect(rows.map((r) => r.name)).toContain("add");
});

test("runSync skips graph parsing for unchanged files (hash-gate)", async () => {
  writeFileSync(join(tempDir, "b.ts"), "export function sub(a: number, b: number){ return a - b; }");

  const { runSync } = await import("../../src/commands/sync.js");
  const { openGraphDb } = await import("../../src/graph/db.js");

  // First sync — populates graph
  await runSync({ root: tempDir, projectId: "test-graph", store: makeMemoryStore(), embeddings: noopEmbeddings });

  // Verify symbol exists
  const db1 = openGraphDb(join(tempDir, ".project-brain", "graph.db"));
  const rows1 = db1.query("SELECT name FROM symbols").all() as { name: string }[];
  db1.close();
  expect(rows1.map((r) => r.name)).toContain("sub");

  // Second sync — same file, same content: should NOT insert a duplicate
  await runSync({ root: tempDir, projectId: "test-graph", store: makeMemoryStore(), embeddings: noopEmbeddings });

  const db2 = openGraphDb(join(tempDir, ".project-brain", "graph.db"));
  const rows2 = db2.query("SELECT name FROM symbols").all() as { name: string }[];
  db2.close();

  // replaceFile does a DELETE then INSERT, so re-parsing would keep count at 1 per symbol.
  // Hash-gate means unchanged file is not re-parsed, so count stays exactly 1.
  expect(rows2.filter((r) => r.name === "sub").length).toBe(1);
});

test("runSync removes graph entries for deleted files", async () => {
  const filePath = join(tempDir, "c.ts");
  writeFileSync(filePath, "export function mul(a: number, b: number){ return a * b; }");

  const { runSync } = await import("../../src/commands/sync.js");
  const { openGraphDb } = await import("../../src/graph/db.js");

  // First sync — indexes c.ts
  await runSync({ root: tempDir, projectId: "test-graph", store: makeMemoryStore(), embeddings: noopEmbeddings });

  const db1 = openGraphDb(join(tempDir, ".project-brain", "graph.db"));
  const rows1 = db1.query("SELECT name FROM symbols").all() as { name: string }[];
  db1.close();
  expect(rows1.map((r) => r.name)).toContain("mul");

  // Delete the file then re-sync
  rmSync(filePath);
  await runSync({ root: tempDir, projectId: "test-graph", store: makeMemoryStore(), embeddings: noopEmbeddings });

  const db2 = openGraphDb(join(tempDir, ".project-brain", "graph.db"));
  const rows2 = db2.query("SELECT name FROM symbols").all() as { name: string }[];
  db2.close();

  expect(rows2.map((r) => r.name)).not.toContain("mul");
});

test("incremental sync (changedFiles) does NOT delete other indexed files", async () => {
  // Regression: the deletion-detection loop must NOT run on the incremental path.
  // changedFiles holds only the edited file, so an unguarded loop would treat
  // every OTHER indexed file as deleted and wipe it from store + graph + manifest
  // on every watcher save (catastrophic data loss).
  writeFileSync(join(tempDir, "one.ts"), "export function one(){ return 1; }");
  writeFileSync(join(tempDir, "two.ts"), "export function two(){ return 2; }");

  const { runSync } = await import("../../src/commands/sync.js");
  const { openGraphDb } = await import("../../src/graph/db.js");

  const store = makeMemoryStore();
  const deletedSources: string[] = [];
  const origDelete = store.deleteBySource;
  store.deleteBySource = async (project, source) => {
    deletedSources.push(source);
    return origDelete(project, source);
  };

  // Full index of both files.
  await runSync({ root: tempDir, projectId: "test-incr", store, embeddings: noopEmbeddings });

  // Edit + incremental sync of ONLY one.ts.
  writeFileSync(join(tempDir, "one.ts"), "export function one(){ return 11; }");
  const result = await runSync({
    root: tempDir,
    projectId: "test-incr",
    store,
    embeddings: noopEmbeddings,
    changedFiles: ["one.ts"],
  });

  // two.ts must survive in the graph and must NOT have been deleted from the store.
  const db = openGraphDb(join(tempDir, ".project-brain", "graph.db"));
  const names = (db.query("SELECT name FROM symbols").all() as { name: string }[]).map((r) => r.name);
  db.close();

  expect(names).toContain("two");
  expect(names).toContain("one");
  expect(result.deleted).toBe(0);
  expect(deletedSources).not.toContain("two.ts");
});

test("--changed-only (empty changedFiles) still reconciles real deletions", async () => {
  // `--changed-only` passes changedFiles:[] which the collection step treats as a
  // FULL hash-gated walk, so deletion detection MUST still run (only the watcher's
  // NON-empty incremental list skips it). Guards must agree on empty-array semantics.
  writeFileSync(join(tempDir, "keep.ts"), "export function keep(){ return 1; }");
  const goPath = join(tempDir, "gone.ts");
  writeFileSync(goPath, "export function gone(){ return 2; }");

  const { runSync } = await import("../../src/commands/sync.js");
  const { openGraphDb } = await import("../../src/graph/db.js");
  const store = makeMemoryStore();

  await runSync({ root: tempDir, projectId: "test-changedonly", store, embeddings: noopEmbeddings });

  // Delete gone.ts, then run in --changed-only mode (empty array).
  rmSync(goPath);
  const result = await runSync({
    root: tempDir,
    projectId: "test-changedonly",
    store,
    embeddings: noopEmbeddings,
    changedFiles: [],
  });

  const db = openGraphDb(join(tempDir, ".project-brain", "graph.db"));
  const names = (db.query("SELECT name FROM symbols").all() as { name: string }[]).map((r) => r.name);
  db.close();

  expect(result.deleted).toBe(1);
  expect(names).toContain("keep");
  expect(names).not.toContain("gone");
});

test("unchanged file → parseFile not called on second sync", async () => {
  writeFileSync(
    join(tempDir, "d.ts"),
    "export function div(a: number, b: number){ return a / b; }"
  );

  const { runSync } = await import("../../src/commands/sync.js");

  const parseFileSpy = spyOn(WasmParser.prototype, "parseFile");

  try {
    // First sync — file is new, parseFile should be called
    await runSync({
      root: tempDir,
      projectId: "test-graph-spy",
      store: makeMemoryStore(),
      embeddings: noopEmbeddings,
    });

    const firstCallCount = parseFileSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Reset call count between syncs
    parseFileSpy.mockClear();

    // Second sync — same file, same content: hash-gate should prevent parseFile call
    await runSync({
      root: tempDir,
      projectId: "test-graph-spy",
      store: makeMemoryStore(),
      embeddings: noopEmbeddings,
    });

    expect(parseFileSpy.mock.calls.length).toBe(0);
  } finally {
    parseFileSpy.mockRestore();
  }
});

test("a structural-extraction failure on one file does not abort indexing of siblings", async () => {
  // Two good TS files. We force WasmParser.warm to throw the FIRST time it runs
  // (simulating a grammar/parse failure for that ext). The per-file structural
  // try/catch must swallow it so BOTH files still get chunked + ingested.
  writeFileSync(join(tempDir, "bad.ts"), "export function bad(a: number){ return a; }");
  writeFileSync(join(tempDir, "good.ts"), "export function good(a: number){ return a; }");

  const { runSync } = await import("../../src/commands/sync.js");

  let threw = false;
  const warmSpy = spyOn(WasmParser.prototype, "warm").mockImplementation(async function (
    this: WasmParser
  ) {
    if (!threw) {
      threw = true;
      throw new Error("forced warm failure");
    }
    // subsequent calls: behave as a no-op (parseFile returns null without ready grammar)
  });

  try {
    const result = await runSync({
      root: tempDir,
      projectId: "test-graph-resilient",
      store: makeMemoryStore(),
      embeddings: noopEmbeddings,
    });

    // The throw must NOT have aborted the run: both files were ingested for embedding.
    expect(warmSpy.mock.calls.length).toBeGreaterThan(0);
    expect(result.ingested).toBe(2);
    expect(result.error).toBeUndefined();
  } finally {
    warmSpy.mockRestore();
  }
});

test("injected graph is used and NOT closed by runSync (caller owns lifecycle)", async () => {
  writeFileSync(
    join(tempDir, "f.ts"),
    "export function pow(a: number, b: number){ return a ** b; }"
  );

  const { runSync } = await import("../../src/commands/sync.js");
  const { openGraphDb } = await import("../../src/graph/db.js");
  const { GraphStore } = await import("../../src/graph/store.js");

  // Caller-owned shared connection.
  const db = openGraphDb(join(tempDir, ".project-brain", "graph.db"));
  const graph = new GraphStore(db);

  await runSync({
    root: tempDir,
    projectId: "test-graph-injected",
    store: makeMemoryStore(),
    embeddings: noopEmbeddings,
    graph,
  });

  // The SAME connection must still be open AFTER runSync returns and must
  // contain the parsed symbols (runSync wrote to the injected graph).
  const rows = graph.findSymbol("pow");
  expect(rows.length).toBeGreaterThan(0);

  // Querying would throw if runSync had closed the connection.
  expect(() => db.query("SELECT 1").get()).not.toThrow();

  graph.close(); // caller closes
});

test("large syncs route structural extraction through a ParserPool and produce the same graph as sequential parsing", async () => {
  const { POOL_MIN_FILES } = await import("../../src/parser/pool.js");

  // One more file than the pool threshold so the pool path is exercised.
  const fileCount = POOL_MIN_FILES + 1;
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(
      join(tempDir, `mod${i}.ts`),
      `export function fn${i}() { return ${i}; }`
    );
  }

  const { runSync } = await import("../../src/commands/sync.js");
  const { openGraphDb } = await import("../../src/graph/db.js");
  const { GraphStore } = await import("../../src/graph/store.js");

  const graph = new GraphStore(openGraphDb(":memory:"));
  const result = await runSync({
    root: tempDir,
    projectId: "test-pool",
    store: makeMemoryStore(),
    embeddings: noopEmbeddings,
    graph,
  });

  expect(result.ingested).toBe(fileCount);
  // Every file's symbol was extracted via the pool path — graph has one
  // function symbol per file.
  for (let i = 0; i < fileCount; i++) {
    expect(graph.findSymbol(`fn${i}`).length).toBe(1);
  }
  graph.close();
});

test("throw during run → parser.dispose and graphDb still cleaned up", async () => {
  // Injection strategy: store.batchReplace throws — this propagates out of runSync
  // reliably because it's awaited inside the try block after embed phase.
  writeFileSync(
    join(tempDir, "e.ts"),
    "export function mod(a: number, b: number){ return a % b; }"
  );

  const { runSync } = await import("../../src/commands/sync.js");

  const throwingStore = makeMemoryStore();
  throwingStore.batchReplace = async () => { throw new Error("store.batchReplace injected failure"); };

  const disposeSpy = spyOn(WasmParser.prototype, "dispose");

  try {
    await expect(
      runSync({
        root: tempDir,
        projectId: "test-graph-throw",
        store: throwingStore,
        embeddings: noopEmbeddings,
      })
    ).rejects.toThrow("injected failure");

    // finally block must have run → dispose was called despite the throw
    expect(disposeSpy.mock.calls.length).toBeGreaterThan(0);
  } finally {
    disposeSpy.mockRestore();
  }
});
