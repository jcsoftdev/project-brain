import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";
import * as castModule from "../../src/indexer/cast.js";

/** Minimal no-op in-memory store (mirrors pattern in sync-graph.test.ts). */
function makeMemoryStore(): VectorStore & { data: Map<string, Chunk[]> } {
  const data = new Map<string, Chunk[]>();
  return {
    data,
    ensureTable: async () => {},
    upsert: async () => {},
    search: async (): Promise<SearchResult[]> => [],
    deleteBySource: async (project: string, source: string) => {
      const existing = data.get(project) ?? [];
      data.set(project, existing.filter((c) => c.source !== source));
    },
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async () => 0,
    optimize: async () => {},
    batchReplace: async (project: string, sources: string[], chunks: Chunk[]) => {
      const existing = (data.get(project) ?? []).filter((c) => !sources.includes(c.source));
      data.set(project, [...existing, ...chunks]);
    },
    buildIndexes: async () => {},
    hybridSearch: async (): Promise<SearchResult[]> => [],
    getChunkById: async () => null,
    assertDim: async () => {},
  } as any;
}

const noopEmbeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.0)),
  isAvailable: async () => true,
};

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "brain-cast-sync-"));
  mkdirSync(join(tempDir, ".project-brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("sync actually invokes castChunk (AST-derived chunking), not just the legacy regex fallback", async () => {
  writeFileSync(
    join(tempDir, "math.ts"),
    `export function add(a: number, b: number) { return a + b; }\n\nexport function sub(a: number, b: number) { return a - b; }\n`
  );

  const { runSync } = await import("../../src/commands/sync.js");
  const store = makeMemoryStore();

  const castChunkSpy = spyOn(castModule, "castChunk");

  try {
    await runSync({
      root: tempDir,
      projectId: "test-cast-sync",
      store,
      embeddings: noopEmbeddings,
    });

    // Proves sync.ts actually passes non-empty boundaries through to
    // chunkContent, which routes to castChunk — not merely that the legacy
    // regex fallback happens to find the same symbol names by coincidence.
    expect(castChunkSpy.mock.calls.length).toBeGreaterThan(0);
    const [, boundariesArg] = castChunkSpy.mock.calls[0]!;
    expect((boundariesArg as unknown[]).length).toBeGreaterThan(0);
  } finally {
    castChunkSpy.mockRestore();
  }

  const chunks = store.data.get("test-cast-sync") ?? [];
  expect(chunks.length).toBeGreaterThan(0);

  // Both tiny functions fit under the cAST budget and greedily merge into a
  // single chunk (correct cAST behavior — see cast.test.ts's "merges small
  // adjacent functions" unit test) — the merged chunk's symbol_name is the
  // FIRST (leading) declaration's name.
  const names = chunks.map((c) => c.symbol_name).filter(Boolean);
  expect(names).toContain("add");

  const addChunk = chunks.find((c) => c.symbol_name === "add")!;
  expect(addChunk.symbol_kind).toBe("function");
  expect(addChunk.start_line).toBeGreaterThan(0);
  expect(addChunk.end_line).toBeGreaterThanOrEqual(addChunk.start_line!);
  // The merged chunk's content spans both functions (proves real merging,
  // not just per-declaration splitting).
  expect(addChunk.content).toContain("function add");
  expect(addChunk.content).toContain("function sub");
});

test("sync via the worker-pool path also produces AST-derived symbol metadata", async () => {
  const { POOL_MIN_FILES } = await import("../../src/parser/pool.js");
  const fileCount = POOL_MIN_FILES + 1;
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(
      join(tempDir, `pmod${i}.ts`),
      `export function pfn${i}() { return ${i}; }\n`
    );
  }

  const { runSync } = await import("../../src/commands/sync.js");
  const store = makeMemoryStore();

  const castChunkSpy = spyOn(castModule, "castChunk");

  try {
    // No injected graph → ownsGraph === true and file count >= POOL_MIN_FILES
    // → the pool path is exercised (see sync-graph.test.ts for the same gate).
    await runSync({
      root: tempDir,
      projectId: "test-cast-sync-pool",
      store,
      embeddings: noopEmbeddings,
    });

    expect(castChunkSpy.mock.calls.length).toBeGreaterThan(0);
  } finally {
    castChunkSpy.mockRestore();
  }

  const chunks = store.data.get("test-cast-sync-pool") ?? [];
  const names = chunks.map((c) => c.symbol_name).filter(Boolean);
  for (let i = 0; i < fileCount; i++) {
    expect(names).toContain(`pfn${i}`);
  }
});

test("re-syncing an unchanged file produces byte-identical cAST chunks (determinism)", async () => {
  const fileContent = `export function alpha() { return 1; }\n\nexport function beta() { return 2; }\n`;

  // Two fully independent roots (own manifest + own graph.db) with the exact
  // same file content, so each sync's hash-manifest gate is fresh and both
  // ACTUALLY run castChunk over the same bytes — a true byte-for-byte
  // determinism check, not a hash-gate skip artifact.
  const tempDirB = mkdtempSync(join(tmpdir(), "brain-cast-sync-b-"));
  mkdirSync(join(tempDirB, ".project-brain"), { recursive: true });

  try {
    writeFileSync(join(tempDir, "stable.ts"), fileContent);
    writeFileSync(join(tempDirB, "stable.ts"), fileContent);

    const { runSync } = await import("../../src/commands/sync.js");
    const store1 = makeMemoryStore();
    const store2 = makeMemoryStore();

    await runSync({ root: tempDir, projectId: "test-determinism", store: store1, embeddings: noopEmbeddings });
    await runSync({ root: tempDirB, projectId: "test-determinism", store: store2, embeddings: noopEmbeddings });

    const stripVolatile = (chunks: Chunk[]) =>
      chunks.map(({ vector, updated_at, ...rest }) => rest);

    const chunksA = stripVolatile(store1.data.get("test-determinism") ?? []);
    const chunksB = stripVolatile(store2.data.get("test-determinism") ?? []);

    expect(chunksA.length).toBeGreaterThan(0);
    expect(chunksA).toEqual(chunksB);
  } finally {
    rmSync(tempDirB, { recursive: true, force: true });
  }
});

test("markdown files are unaffected by cAST wiring — still chunked by heading", async () => {
  writeFileSync(
    join(tempDir, "README.md"),
    `# Title\n\nIntro text.\n\n## Section\n\nMore text.\n`
  );

  const { runSync } = await import("../../src/commands/sync.js");
  const store = makeMemoryStore();

  await runSync({
    root: tempDir,
    projectId: "test-cast-sync-md",
    store,
    embeddings: noopEmbeddings,
  });

  const chunks = store.data.get("test-cast-sync-md") ?? [];
  expect(chunks.length).toBeGreaterThanOrEqual(1);
  expect(chunks.every((c) => c.symbol_kind === "section" || c.symbol_kind === undefined)).toBe(true);
});
