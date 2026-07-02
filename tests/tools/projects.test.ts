import { describe, it, expect } from "bun:test";
import { handleListProjects, handleDeleteProject } from "../../src/tools/projects.js";
import type { VectorStore, EmbeddingClient } from "../../src/types.js";

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
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async () => 0,
    optimize: async () => {},
    buildIndexes: async () => {},
    hybridSearch: async () => [],
    getChunkById: async () => null,
    assertDim: async () => {},
  };
}

describe("list_projects tool", () => {
  it("maps store output to structuredContent { projects }", async () => {
    const store: VectorStore = {
      ...baseStore(),
      listProjects: async () => [
        { project: "alpha", chunks: 2, model: "nomic-embed-text", dim: 768 },
        { project: "beta", chunks: 1 },
      ],
    };
    const result = await handleListProjects({}, { store, embeddings: mockEmbeddings });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as any;
    expect(data.projects).toHaveLength(2);
    expect(data.projects[0]).toEqual({ project: "alpha", chunks: 2, model: "nomic-embed-text", dim: 768 });
    expect(data.projects[1]).toEqual({ project: "beta", chunks: 1 });
  });

  it("returns ADMIN_UNSUPPORTED when store lacks listProjects", async () => {
    const store = baseStore();
    const result = await handleListProjects({}, { store, embeddings: mockEmbeddings });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).code).toBe("ADMIN_UNSUPPORTED");
  });
});

describe("delete_project tool", () => {
  it("respects confirmDestructive — cancelled path leaves the store untouched", async () => {
    let deleted = false;
    let asked = "";
    const store: VectorStore = {
      ...baseStore(),
      countChunks: async () => 5,
      deleteProject: async () => { deleted = true; return true; },
    };
    const deps = {
      store,
      embeddings: mockEmbeddings,
      confirmDestructive: async (msg: string) => { asked = msg; return false; },
    };
    const result = await handleDeleteProject({ project: "alpha" }, deps);
    expect(asked).toContain("alpha");
    expect(deleted).toBe(false);
    expect((result.structuredContent as any).status).toBe("cancelled");
    expect(result.isError).toBeFalsy();
  });

  it("reports deleted when store confirms deletion", async () => {
    const store: VectorStore = { ...baseStore(), deleteProject: async () => true };
    const result = await handleDeleteProject({ project: "alpha" }, { store, embeddings: mockEmbeddings });
    expect((result.structuredContent as any)).toEqual({ project: "alpha", status: "deleted" });
  });

  it("reports not_found when the project doesn't exist", async () => {
    const store: VectorStore = { ...baseStore(), deleteProject: async () => false };
    const result = await handleDeleteProject({ project: "ghost" }, { store, embeddings: mockEmbeddings });
    expect((result.structuredContent as any)).toEqual({ project: "ghost", status: "not_found" });
  });

  it("returns ADMIN_UNSUPPORTED when store lacks deleteProject", async () => {
    const store = baseStore();
    const result = await handleDeleteProject({ project: "alpha" }, { store, embeddings: mockEmbeddings });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).code).toBe("ADMIN_UNSUPPORTED");
  });
});
