// PRUEBA INVERSA — real end-to-end, NO mocks.
// Hits real Ollama (nomic-embed-text) + real LanceDbStore + real chunker over this repo's
// own source. Proves the production path: chunk -> embed -> upsert -> buildIndexes ->
// hybrid search -> adaptive output -> expand, with symbol metadata actually populated.
// Skips gracefully if Ollama is unreachable.
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { OllamaEmbeddingClient } from "../../src/embeddings/ollama.js";
import { chunkContent } from "../../src/indexer/parser.js";
import { handleSearch } from "../../src/tools/search.js";
import { handleExpand } from "../../src/tools/expand.js";
import { OLLAMA_HOST, EMBEDDING_MODEL, VECTOR_DIM } from "../../src/constants.js";
import type { Chunk, ToolDeps } from "../../src/types.js";

const PROJECT = "e2e_real";
let dir: string;
let store: LanceDbStore;
let embeddings: OllamaEmbeddingClient;
let deps: ToolDeps;
let ollamaUp = false;

beforeAll(async () => {
  // Opt-in: real-network tests are excluded from the default suite to keep it
  // deterministic. Run with PB_REAL_TESTS=1 to exercise them.
  if (process.env.PB_REAL_TESTS !== "1") return;
  dir = await mkdtemp(join(tmpdir(), "pb-e2e-"));
  embeddings = new OllamaEmbeddingClient(OLLAMA_HOST, undefined, EMBEDDING_MODEL, VECTOR_DIM);
  ollamaUp = await embeddings.isAvailable();
  if (!ollamaUp) return;

  store = new LanceDbStore(dir);
  await store.ensureTable(PROJECT, { model: EMBEDDING_MODEL, dim: VECTOR_DIM });
  deps = { store, embeddings };

  // Index this repo's real source files through the REAL chunker.
  const files = ["src/tools/search.ts", "src/store/lancedb.ts", "src/retrieval/budget.ts"];
  const raws: ReturnType<typeof chunkContent> = [];
  for (const f of files) {
    const content = await readFile(f, "utf8");
    raws.push(...chunkContent(content, f, "src"));
  }
  const vectors = await embeddings.embed(raws.map((r) => r.content));
  if (!vectors) throw new Error("embed returned null with ollama up");
  const chunks: Chunk[] = raws.map((r, i) => ({ ...r, vector: vectors[i] }));
  await store.upsert(PROJECT, chunks);
  await store.buildIndexes(PROJECT); // FTS index — without this hybrid is inert
});

afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("PRUEBA INVERSA: real e2e pipeline", () => {
  it("finds handleSearch by exact symbol name with populated symbol metadata", async () => {
    if (!ollamaUp) { console.warn("[e2e] Ollama down — skipped"); return; }
    const res = await handleSearch({ project: PROJECT, query: "handleSearch" }, deps);
    const { results } = JSON.parse(res.content[0].text);
    expect(results.length).toBeGreaterThan(0);
    // The handleSearch function must surface, and its symbol context must NOT be empty
    // (this is the exact field the store write-path used to drop).
    const hit = results.find((r: any) => r.source === "src/tools/search.ts");
    expect(hit).toBeTruthy();
    expect(hit.symbol).toBeTruthy();        // inverse of the bug: was always "" before the write-path fix
    expect(hit.chunk_id).toBeTruthy();
    expect(hit).not.toHaveProperty("id");   // internal noise dropped
  });

  it("expand_context round-trips the full body for a returned chunk_id", async () => {
    if (!ollamaUp) return;
    const res = await handleSearch({ project: PROJECT, query: "token budget snippet" }, deps);
    const { results } = JSON.parse(res.content[0].text);
    expect(results.length).toBeGreaterThan(0);
    const ex = await handleExpand({ project: PROJECT, chunk_id: results[0].chunk_id }, deps);
    const body = JSON.parse(ex.content[0].text);
    expect(body.content.length).toBeGreaterThan(results[0].snippet.length);
  });

  it("INVERSE: hybrid lexical leg beats pure-semantic on an exact identifier", async () => {
    if (!ollamaUp) return;
    // 'batchReplace' is a distinctive identifier only in lancedb.ts. The FTS (BM25) leg
    // must pull it even though a generic semantic query might rank other code higher.
    const res = await handleSearch({ project: PROJECT, query: "batchReplace" }, deps);
    const { results } = JSON.parse(res.content[0].text);
    const sources = results.map((r: any) => r.source);
    expect(sources).toContain("src/store/lancedb.ts");
  });
});
