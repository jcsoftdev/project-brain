// PRUEBA INVERSA — real end-to-end structural graph over THIS repo's own src/.
// NO mocks for the structural path: real WASM parser + real extract + real GraphStore
// over the actual source tree. Embeddings are stubbed (noop) and the vector store is
// in-memory, because this test exercises the STRUCTURAL layer, not retrieval — so it
// needs no Ollama.
//
// Proves the production path: walk -> WASM parse -> extract symbols+edges -> GraphStore,
// then findSymbol / findCallers / findCallees / impact return real results.
// Skips gracefully if web-tree-sitter WASM cannot initialise in this runtime.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { VECTOR_DIM } from "../../src/constants.js";
import { WasmParser } from "../../src/parser/wasm.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

/** Minimal no-op in-memory store (mirrors sync-graph.test.ts). */
function makeMemoryStore(): VectorStore {
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

/** No-op embedding client — returns zero vectors, no Ollama needed. */
const noopEmbeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.0)),
  isAvailable: async () => true,
};

let dir: string;
let wasmOk = false;

beforeAll(async () => {
  // Gate on WASM availability: if the grammar cannot load in this runtime, skip
  // (mirror of e2e-real's graceful skip). Do NOT fail the suite on environment.
  try {
    const p = new WasmParser();
    await p.init();
    await p.warm(".ts");
    const t = p.parseFile(".ts", "export function a(){return 1;}");
    if (t) t.tree.delete();
    p.dispose();
    wasmOk = t !== null;
  } catch {
    wasmOk = false;
  }
  if (!wasmOk) return;

  // Copy this repo's real src/ tree into an isolated temp root and index it.
  dir = mkdtempSync(join(tmpdir(), "pb-graph-e2e-"));
  mkdirSync(join(dir, ".project-brain"), { recursive: true });
  cpSync("src", join(dir, "src"), { recursive: true });

  const { runSync } = await import("../../src/commands/sync.js");
  await runSync({
    root: dir,
    projectId: "graph-e2e",
    store: makeMemoryStore(),
    embeddings: noopEmbeddings,
  });
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function openGraph() {
  const { openGraphDb } = require("../../src/graph/db.js");
  return openGraphDb(join(dir, ".project-brain", "graph.db"));
}

test("findSymbol resolves a real exported function to its source file", () => {
  if (!wasmOk) { console.warn("[graph-e2e] WASM unavailable — skipped"); return; }
  const db = openGraph();
  const store = new (require("../../src/graph/store.js").GraphStore)(db);
  const hits = store.findSymbol("createServer");
  db.close();
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.some((h: any) => h.path.endsWith("src/server.ts"))).toBe(true);
});

test("findCallers returns the real caller of formatHits", () => {
  if (!wasmOk) return;
  const db = openGraph();
  const store = new (require("../../src/graph/store.js").GraphStore)(db);
  const callers = store.findCallers("formatHits").map((h: any) => h.name);
  db.close();
  // handleFindSymbol (src/tools/find-symbol.ts) calls formatHits.
  expect(callers).toContain("handleFindSymbol");
});

test("findCallees returns the real callee of handleFindSymbol", () => {
  if (!wasmOk) return;
  const db = openGraph();
  const store = new (require("../../src/graph/store.js").GraphStore)(db);
  const callees = store.findCallees("handleFindSymbol").map((h: any) => h.name);
  db.close();
  expect(callees).toContain("formatHits");
});

test("impact of a low-level symbol is non-empty (real reverse call graph)", () => {
  if (!wasmOk) return;
  const db = openGraph();
  const store = new (require("../../src/graph/store.js").GraphStore)(db);
  const affected = store.impact("formatHits").map((h: any) => h.name);
  db.close();
  expect(affected.length).toBeGreaterThan(0);
  expect(affected).toContain("handleFindSymbol");
});
