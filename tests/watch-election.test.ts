import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../src/constants.js";
import { WATCH_LOCK_FILE, acquireWatchLock } from "../src/watcher-lock.js";
import { startWatchElection } from "../src/serve.js";
import type { EmbeddingClient, VectorStore, SearchResult } from "../src/types.js";

function makeStore(): VectorStore {
  return {
    ensureTable: async () => {},
    upsert: async () => {},
    search: async (): Promise<SearchResult[]> => [],
    deleteBySource: async () => {},
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async () => 0,
    optimize: async () => {},
    batchReplace: async () => {},
    buildIndexes: async () => {},
    hybridSearch: async (): Promise<SearchResult[]> => [],
    getChunkById: async () => null,
    assertDim: async () => {},
  } as unknown as VectorStore;
}

const embeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
  isAvailable: async () => true,
};

/**
 * Election, not serialisation.
 *
 * N MCP hosts in one repo each started a FileWatcher on the same root, so one
 * save became N syncs over identical content. Measured with two watchers and
 * one file written: 2 syncs, 2 batchReplace calls. This removes the duplicate
 * work rather than queueing it behind a second lock.
 */
describe("startWatchElection", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pb-election-"));
    await mkdir(join(root, ".project-brain"), { recursive: true });
    await writeFile(
      join(root, ".project-brain", "project.json"),
      JSON.stringify({ projectId: "elect", root })
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const lockPath = () => join(root, ".project-brain", WATCH_LOCK_FILE);

  it("watches when the root is free", async () => {
    const handle = await startWatchElection(root, { store: makeStore(), embeddings });
    try {
      expect(handle.watching).toBe(true);
      expect(JSON.parse(await readFile(lockPath(), "utf8")).pid).toBe(process.pid);
    } finally {
      await handle.stop();
    }
  });

  it("does not watch when a live process already holds the root", async () => {
    // The whole point: the second server serves normally and simply does not
    // duplicate the first one's indexing work.
    const incumbent = await acquireWatchLock(root);
    expect(incumbent).not.toBeNull();

    const handle = await startWatchElection(root, { store: makeStore(), embeddings });
    try {
      expect(handle.watching).toBe(false);
    } finally {
      await handle.stop();
      await incumbent!.release();
    }
  });

  it("takes the root over on retry once the incumbent is gone", async () => {
    // Failover without a heartbeat: the loser keeps asking, and the moment the
    // holder's lock is free the next check wins it. Without this, killing the
    // elected server leaves the project unwatched until a human restarts
    // something.
    const incumbent = await acquireWatchLock(root);
    const handle = await startWatchElection(root, {
      store: makeStore(),
      embeddings,
      retryMs: 20,
    });
    try {
      expect(handle.watching).toBe(false);

      await incumbent!.release();
      await new Promise((r) => setTimeout(r, 120));

      expect(handle.watching).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it("frees the root on stop so another process can take it", async () => {
    const handle = await startWatchElection(root, { store: makeStore(), embeddings });
    expect(handle.watching).toBe(true);

    await handle.stop();

    const next = await acquireWatchLock(root);
    expect(next).not.toBeNull();
    await next!.release();
  });

  it("stops cleanly when it never won the election", async () => {
    // stop() runs on every shutdown path, including the losers'. It must not
    // assume a watcher exists, and must not release a lock it does not hold.
    const incumbent = await acquireWatchLock(root);
    const handle = await startWatchElection(root, {
      store: makeStore(),
      embeddings,
      retryMs: 20,
    });

    await handle.stop();

    // The incumbent's lock survived the loser's shutdown.
    expect(JSON.parse(await readFile(lockPath(), "utf8")).pid).toBe(process.pid);
    await incumbent!.release();
  });

  it("stops retrying after stop()", async () => {
    // A leaked interval keeps the event loop alive and the process never exits.
    const incumbent = await acquireWatchLock(root);
    const handle = await startWatchElection(root, {
      store: makeStore(),
      embeddings,
      retryMs: 20,
    });
    await handle.stop();

    await incumbent!.release();
    await new Promise((r) => setTimeout(r, 120));

    // Had the interval survived, it would have won the free root by now.
    expect(handle.watching).toBe(false);
  });
});
