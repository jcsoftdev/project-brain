import { describe, it, expect } from "bun:test";
import { handleIngest } from "../../src/tools/ingest.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { VectorStore, EmbeddingClient, Chunk, ToolDeps } from "../../src/types.js";

/** Records which project id every write was routed to. */
function makeRecordingStore(): VectorStore & { targets: string[] } {
  const store = {
    targets: [] as string[],
    ensureTable: async (project: string) => {
      store.targets.push(project);
    },
    upsert: async (project: string, _chunks: Chunk[]) => {
      store.targets.push(project);
    },
    search: async () => [],
    deleteBySource: async () => {},
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async () => 0,
    optimize: async () => {},
    batchReplace: async () => {},
    buildIndexes: async () => {},
    hybridSearch: async () => [],
    getChunkById: async () => null,
    assertDim: async () => {},
  };
  return store;
}

const embeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
  model: "nomic-embed-text",
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
  isAvailable: async () => true,
};

function deps(store: VectorStore): ToolDeps {
  return { store, embeddings } as unknown as ToolDeps;
}

const note = { content: "we chose X over Y", source: "decisions.md", module: "docs" };

describe("add_knowledge from a worktree", () => {
  it("routes a scoped project id to the base project", async () => {
    const store = makeRecordingStore();
    await handleIngest({ project: "demo-repo@agent-a", ...note }, deps(store));

    expect(new Set(store.targets)).toEqual(new Set(["demo-repo"]));
  });

  it("leaves an unscoped project id alone", async () => {
    const store = makeRecordingStore();
    await handleIngest({ project: "demo-repo", ...note }, deps(store));

    expect(new Set(store.targets)).toEqual(new Set(["demo-repo"]));
  });

  it("reports the project it actually wrote to", async () => {
    const store = makeRecordingStore();
    const result = await handleIngest({ project: "demo-repo@agent-a", ...note }, deps(store));
    const payload = JSON.parse(result.content[0].text as string);

    expect(payload.project).toBe("demo-repo");
  });

  it("lands two worktrees' notes in the one shared table", async () => {
    const store = makeRecordingStore();
    await handleIngest({ project: "demo-repo@wt-a", ...note }, deps(store));
    await handleIngest({ project: "demo-repo@wt-b", ...note }, deps(store));

    expect(new Set(store.targets)).toEqual(new Set(["demo-repo"]));
  });
});
