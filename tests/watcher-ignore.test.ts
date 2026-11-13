/**
 * The watcher must not wake a sync for writes under `.claude/`: agents keep
 * whole worktrees there, so every edit in one would otherwise schedule a sync
 * of the parent checkout.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FileWatcher, type WatchFn } from "../src/watcher.js";
import * as registry from "../src/store/project-registry.js";
import type { EmbeddingClient, VectorStore } from "../src/types.js";

const store: VectorStore = {
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

const embeddings: EmbeddingClient = {
  dim: 8,
  model: "test",
  embed: async (texts) => texts.map(() => new Array(8).fill(0.1)),
  isAvailable: async () => true,
};

describe("watcher ignores .claude/", () => {
  let root: string;
  let registerSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-watch-ignore-"));
    await writeFile(join(root, "a.md"), "# A\n\nalpha");
    registerSpy = spyOn(registry, "registerProject").mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    registerSpy.mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  /** Emit `events`, let the debounce fire, and count the syncs it started. */
  async function syncsFor(events: string[]): Promise<number> {
    let emit: (filename: string) => void = () => {};
    const watchFn: WatchFn = (_root, onEvent) => {
      emit = onEvent;
      return { close: () => {} };
    };
    let syncs = 0;
    const watcher = new FileWatcher({
      root,
      projectId: "watch-ignore",
      store,
      embeddings,
      embeddingsFor: async () => {
        syncs++;
        return embeddings;
      },
      debounceMs: 5,
      watchFn,
    });
    watcher.start();
    for (const event of events) emit(event);
    await new Promise((r) => setTimeout(r, 50));
    await watcher.stop();
    return syncs;
  }

  it("starts no sync for writes inside an agent worktree", async () => {
    expect(
      await syncsFor([".claude/worktrees/agent-x/README.md", ".claude/worktrees/agent-x/src/a.ts"])
    ).toBe(0);
  });

  it("still syncs an ordinary project file", async () => {
    expect(await syncsFor(["a.md"])).toBe(1);
  });
});
