import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NullEmbeddingClient } from "../../src/embeddings/null.js";
import type { VectorStore, Chunk, SearchResult, TableMeta } from "../../src/types.js";

function makeMemoryStore(): VectorStore & { data: Map<string, Chunk[]> } {
  const data = new Map<string, Chunk[]>();
  return {
    data,
    ensureTable: async () => {},
    upsert: async (project: string, chunks: Chunk[]) => {
      const existing = data.get(project) ?? [];
      data.set(project, [...existing, ...chunks]);
    },
    search: async (): Promise<SearchResult[]> => [],
    deleteBySource: async (project: string, source: string) => {
      data.set(project, (data.get(project) ?? []).filter((c) => c.source !== source));
    },
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
  } as unknown as VectorStore & { data: Map<string, Chunk[]> };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "brain-lexical-only-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("runSync — lexical-only mode (NullEmbeddingClient)", () => {
  it("stores all chunks with a placeholder vector, embedFailed=0, no error", async () => {
    await writeFile(join(tempDir, "a.ts"), "export function a(x: number) { return x + 1; }");
    await writeFile(join(tempDir, "b.ts"), "export function b(x: number) { return x * 2; }");

    const { runSync } = await import("../../src/commands/sync.js");
    const store = makeMemoryStore();
    const embeddings = new NullEmbeddingClient();

    const result = await runSync({ root: tempDir, projectId: "lex-test", store, embeddings });

    expect(result.error).toBeUndefined();
    expect(result.embedFailed).toBe(0);
    expect(result.ingested).toBe(2);

    const chunks = store.data.get("lex-test") ?? [];
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.vector).toEqual([0]);
    }
  });

  it("never calls embed() on NullEmbeddingClient — nothing to call, nothing that can fail", async () => {
    await writeFile(join(tempDir, "a.ts"), "export function a() { return 1; }");

    const { runSync } = await import("../../src/commands/sync.js");
    const store = makeMemoryStore();
    const embeddings = new NullEmbeddingClient();
    let embedCalls = 0;
    const originalEmbed = embeddings.embed.bind(embeddings);
    (embeddings as any).embed = async (texts: string[]) => {
      embedCalls++;
      return originalEmbed(texts);
    };

    await runSync({ root: tempDir, projectId: "lex-test-2", store, embeddings });
    expect(embedCalls).toBe(0);
  });
});
