import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FileWatcher, type WatchFn } from "../src/watcher.js";
import type { EmbeddingClient, VectorStore, TableMeta } from "../src/types.js";

function makeRecordingStore(): VectorStore & { ensured: Array<TableMeta | undefined> } {
  const store = {
    ensured: [] as Array<TableMeta | undefined>,
    ensureTable: async (_project: string, meta?: TableMeta) => {
      store.ensured.push(meta);
    },
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
  return store;
}

const client = (model: string, dim: number): EmbeddingClient => ({
  dim,
  model,
  embed: async (texts) => texts.map(() => new Array(dim).fill(0.1)),
  isAvailable: async () => true,
});

describe("watcher sync on a project indexed with a model other than the server default", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-watch-model-"));
    await writeFile(join(root, "a.md"), "# A\n\nalpha");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ensures the table with the project's own model, never the default's dim", async () => {
    const store = makeRecordingStore();
    let emit: (filename: string) => void = () => {};
    const watchFn: WatchFn = (_root, onEvent) => {
      emit = onEvent;
      return { close: () => {} };
    };
    const watcher = new FileWatcher({
      root,
      projectId: "demo",
      store,
      embeddings: client("server-default", 32),
      embeddingsFor: async () => client("project-model", 16),
      debounceMs: 5,
      watchFn,
    });

    watcher.start();
    emit("a.md");
    await new Promise((r) => setTimeout(r, 50));
    await watcher.stop();

    expect(store.ensured).toEqual([{ model: "project-model", dim: 16 }]);
  });
});
