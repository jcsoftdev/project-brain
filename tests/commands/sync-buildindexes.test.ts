/**
 * RED tests for FIX 1: runSync must call store.buildIndexes after all chunks are persisted.
 * RED tests for FIX 2: symbol metadata from parser RawChunk must survive the chunk mapping.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

function makeTrackingStore(): VectorStore & {
  data: Map<string, Chunk[]>;
  buildIndexesCalled: boolean;
  buildIndexesCalledWith: string[];
} {
  const data = new Map<string, Chunk[]>();
  const store = {
    data,
    buildIndexesCalled: false,
    buildIndexesCalledWith: [] as string[],
    ensureTable: async () => {},
    upsert: async (project: string, chunks: Chunk[]) => {
      const existing = data.get(project) ?? [];
      for (const chunk of chunks) {
        const idx = existing.findIndex((c) => c.id === chunk.id);
        if (idx >= 0) existing[idx] = chunk;
        else existing.push(chunk);
      }
      data.set(project, existing);
    },
    search: async (): Promise<SearchResult[]> => [],
    hybridSearch: async (): Promise<SearchResult[]> => [],
    deleteBySource: async (project: string, source: string) => {
      const existing = data.get(project) ?? [];
      data.set(project, existing.filter((c) => c.source !== source));
    },
    listModules: async (project: string) => {
      const chunks = data.get(project) ?? [];
      return [...new Set(chunks.map((c) => c.module))].sort();
    },
    getModuleChunks: async (project: string, module: string) => {
      const chunks = data.get(project) ?? [];
      return chunks.filter((c) => c.module === module);
    },
    countChunks: async (project: string) => (data.get(project) ?? []).length,
    optimize: async () => {},
    batchReplace: async (project: string, sources: string[], chunks: Chunk[]) => {
      const existing = (data.get(project) ?? []).filter((c) => !sources.includes(c.source));
      data.set(project, [...existing, ...chunks]);
    },
    buildIndexes: async (project: string) => {
      store.buildIndexesCalled = true;
      store.buildIndexesCalledWith.push(project);
    },
    getChunkById: async (_project: string, _id: string): Promise<Chunk | null> => null,
    assertDim: async () => {},
  };
  return store;
}

const mockEmbeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
  isAvailable: async () => true,
};

describe("FIX 1: runSync calls buildIndexes after persisting chunks", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-buildidx-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("calls store.buildIndexes with the projectId after all chunks are stored", async () => {
    const store = makeTrackingStore();
    await writeFile(join(tempDir, "README.md"), "# Hello\n\nSome content here.");

    const { runSync } = await import("../../src/commands/sync.js");
    await runSync({
      root: tempDir,
      projectId: "test-proj",
      store,
      embeddings: mockEmbeddings,
    });

    expect(store.buildIndexesCalled).toBe(true);
    expect(store.buildIndexesCalledWith).toContain("test-proj");
  });

  it("calls buildIndexes even when all files are skipped (no changes)", async () => {
    const store = makeTrackingStore();
    await writeFile(join(tempDir, "stable.md"), "Unchanged content.");

    const { runSync } = await import("../../src/commands/sync.js");

    // First sync to populate hash manifest
    await runSync({
      root: tempDir,
      projectId: "test-proj",
      store,
      embeddings: mockEmbeddings,
    });

    // Reset tracking
    store.buildIndexesCalled = false;
    store.buildIndexesCalledWith = [];

    // Second sync — file is unchanged, but buildIndexes should still be called
    await runSync({
      root: tempDir,
      projectId: "test-proj",
      store,
      embeddings: mockEmbeddings,
    });

    expect(store.buildIndexesCalled).toBe(true);
  });
});

describe("FIX 2: symbol metadata survives sync chunk mapping", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-symbmeta-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists symbol_name and symbol_kind when parser produces them", async () => {
    const store = makeTrackingStore();
    // A TypeScript file with a named function that the parser will detect
    await writeFile(
      join(tempDir, "auth.ts"),
      `export function authenticate(token: string): boolean {
  return token.length > 0;
}
`
    );

    const { runSync } = await import("../../src/commands/sync.js");
    await runSync({
      root: tempDir,
      projectId: "test-proj",
      store,
      embeddings: mockEmbeddings,
    });

    const chunks = store.data.get("test-proj") ?? [];
    expect(chunks.length).toBeGreaterThan(0);

    // At least one chunk should carry symbol metadata from the parser
    const withSymbol = chunks.filter((c) => c.symbol_name !== undefined);
    expect(withSymbol.length).toBeGreaterThan(0);
  });

  it("persists start_line and end_line when parser produces them", async () => {
    const store = makeTrackingStore();
    await writeFile(
      join(tempDir, "utils.ts"),
      `export class Formatter {
  format(value: string): string {
    return value.trim();
  }
}
`
    );

    const { runSync } = await import("../../src/commands/sync.js");
    await runSync({
      root: tempDir,
      projectId: "test-proj",
      store,
      embeddings: mockEmbeddings,
    });

    const chunks = store.data.get("test-proj") ?? [];
    const withLines = chunks.filter((c) => c.start_line !== undefined && c.end_line !== undefined);
    expect(withLines.length).toBeGreaterThan(0);
  });
});
