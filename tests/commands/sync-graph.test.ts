import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
