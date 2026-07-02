import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { handleArchitecture } from "../../src/tools/architecture.js";
import type { VectorStore, EmbeddingClient } from "../../src/types.js";
import type { GraphStore } from "../../src/graph/store.js";

const mockEmbeddings: EmbeddingClient = {
  embed: async () => null,
  isAvailable: async () => false,
};

function baseStore(): VectorStore {
  return {
    ensureTable: async () => {},
    upsert: async () => {},
    batchReplace: async () => {},
    search: async () => [],
    deleteBySource: async () => {},
    listModules: async () => ["src", "docs"],
    getModuleChunks: async () => [],
    countChunks: async () => 42,
    optimize: async () => {},
    buildIndexes: async () => {},
    hybridSearch: async () => [],
    getChunkById: async () => null,
    assertDim: async () => {},
  };
}

describe("get_architecture tool", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "architecture-"));
    await Bun.write(join(tempDir, "package.json"), JSON.stringify({ name: "fixture-project" }));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("composes stack + modules + chunks + symbols into structuredContent", async () => {
    const deps = {
      projectRoot: tempDir,
      store: baseStore(),
      embeddings: mockEmbeddings,
      graph: { countSymbols: () => 7 } as unknown as GraphStore,
    };
    const result = await handleArchitecture({ project: "demo" }, deps);
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as any;
    expect(data.modules).toEqual(["src", "docs"]);
    expect(data.chunks).toBe(42);
    expect(data.symbols).toBe(7);
    expect(data.stack).toBeDefined();
    expect(data.stack.manifest).toBe("package.json");
  });

  it("defaults symbols to 0 when graph is absent", async () => {
    const deps = {
      projectRoot: tempDir,
      store: baseStore(),
      embeddings: mockEmbeddings,
    };
    const result = await handleArchitecture({ project: "demo" }, deps);
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as any;
    expect(data.symbols).toBe(0);
  });

  it("returns PROJECT_ROOT_UNAVAILABLE when projectRoot is absent", async () => {
    const deps = {
      store: baseStore(),
      embeddings: mockEmbeddings,
    };
    const result = await handleArchitecture({ project: "demo" }, deps);
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).code).toBe("PROJECT_ROOT_UNAVAILABLE");
  });
});
