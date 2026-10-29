import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runSync } from "../../src/commands/sync.js";
import { VECTOR_DIM } from "../../src/constants.js";
import { GraphStore } from "../../src/graph/store.js";
import { openGraphDb } from "../../src/graph/db.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

function makeMemoryStore(): VectorStore {
  const data = new Map<string, Chunk[]>();
  return {
    data,
    ensureTable: async () => {},
    upsert: async () => {},
    search: async (): Promise<SearchResult[]> => [],
    deleteBySource: async () => {},
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async (project: string) => (data.get(project) ?? []).length,
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

// Regression: the MCP watcher calls runSync with an injected graph on every
// save. A fresh WasmParser per sync leaked ~6 MB RSS each (grammar load is
// never released by dispose()); the injected path must reuse a shared parser.
test("runSync with an injected graph does not leak RSS across repeated syncs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-parser-leak-"));
  mkdirSync(join(dir, ".project-brain"), { recursive: true });
  const graph = new GraphStore(openGraphDb(":memory:"));
  try {
    const files = ["a.ts", "b.ts", "c.ts"];
    for (const f of files) writeFileSync(join(dir, f), `export const ${f[0]} = 0;\n`);

    const store = makeMemoryStore();
    const rss: number[] = [];
    const runs = 25;
    for (let i = 0; i < runs; i++) {
      writeFileSync(
        join(dir, files[i % files.length]!),
        `export function f${i}(x: number) { return x + ${i}; }\n`,
      );
      await runSync({ root: dir, projectId: "leak", store, embeddings: noopEmbeddings, graph });
      Bun.gc(true);
      rss.push(process.memoryUsage().rss);
    }

    const growthMb = (rss[runs - 1]! - rss[4]!) / 1024 / 1024;
    expect(growthMb).toBeLessThan(40);
  } finally {
    graph.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
