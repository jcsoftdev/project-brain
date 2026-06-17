import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM, WATCHER_DEBOUNCE_MS } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

function makeMemoryStore(): VectorStore & { data: Map<string, Chunk[]> } {
  const data = new Map<string, Chunk[]>();
  return {
    data,
    ensureTable: async () => {},
    upsert: async (project, chunks) => {
      const existing = data.get(project) ?? [];
      for (const chunk of chunks) {
        const idx = existing.findIndex((c) => c.id === chunk.id);
        if (idx >= 0) existing[idx] = chunk;
        else existing.push(chunk);
      }
      data.set(project, existing);
    },
    search: async (): Promise<SearchResult[]> => [],
    deleteBySource: async (project, source) => {
      const existing = data.get(project) ?? [];
      data.set(
        project,
        existing.filter((c) => c.source !== source)
      );
    },
    listModules: async (project) => {
      const chunks = data.get(project) ?? [];
      return [...new Set(chunks.map((c) => c.module))].sort();
    },
    getModuleChunks: async (project, module) => {
      const chunks = data.get(project) ?? [];
      return chunks.filter((c) => c.module === module);
    },
    countChunks: async (project) => (data.get(project) ?? []).length,
    optimize: async () => {},
      batchReplace: async (project, sources, chunks) => {
        const existing = (data.get(project) ?? []).filter((c) => !sources.includes(c.source));
        data.set(project, [...existing, ...chunks]);
      },
      buildIndexes: async () => {},
      hybridSearch: async (): Promise<SearchResult[]> => [],
      getChunkById: async () => null,
      assertDim: async () => {},
  };
}

const mockEmbeddings: EmbeddingClient = {
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
  isAvailable: async () => true,
};

/**
 * T-8.1: FileWatcher creates a watcher that can be started and stopped.
 * T-8.2: Watcher triggers sync callback on file change (debounced).
 *
 * Note: We test the debounce logic and the watcher interface rather than
 * full FSEvents integration (which is environment-specific). The watcher
 * is tested via its exported pure helper functions and interface contract.
 */
describe("FileWatcher", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-watch-"));
    await mkdir(join(tempDir, ".project-brain"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("T-8.1: FileWatcher class interface", () => {
    it("exports FileWatcher class", async () => {
      const mod = await import("../../src/watcher.js");
      expect(typeof mod.FileWatcher).toBe("function");
    });

    it("FileWatcher instance has start and stop methods", async () => {
      const { FileWatcher } = await import("../../src/watcher.js");
      const store = makeMemoryStore();
      const watcher = new FileWatcher({
        root: tempDir,
        projectId: "test",
        store,
        embeddings: mockEmbeddings,
      });
      expect(typeof watcher.start).toBe("function");
      expect(typeof watcher.stop).toBe("function");
    });

    it("stop is safe to call before start", async () => {
      const { FileWatcher } = await import("../../src/watcher.js");
      const store = makeMemoryStore();
      const watcher = new FileWatcher({
        root: tempDir,
        projectId: "test",
        store,
        embeddings: mockEmbeddings,
      });
      // Should not throw
      await expect(watcher.stop()).resolves.toBeUndefined();
    });
  });

  describe("T-8.2: live watch wiring (injected watch factory)", () => {
    it("start() registers the watcher on the project root via injected factory", async () => {
      const { FileWatcher } = await import("../../src/watcher.js");
      const store = makeMemoryStore();

      let watchedRoot: string | null = null;
      const fakeWatch = (root: string) => {
        watchedRoot = root;
        return { close() {} };
      };

      const watcher = new FileWatcher({
        root: tempDir,
        projectId: "test",
        store,
        embeddings: mockEmbeddings,
        watchFn: fakeWatch,
      });
      watcher.start();

      expect(watchedRoot).toBe(tempDir);
      await watcher.stop();
    });

    it("a filesystem event triggers debounced sync that ingests the changed file", async () => {
      const { FileWatcher } = await import("../../src/watcher.js");
      const store = makeMemoryStore();

      // Real file the sync will read + ingest.
      await writeFile(join(tempDir, "notes.md"), "# Notes\n\nSome content.\n");

      let emit: ((filename: string) => void) | null = null;
      const fakeWatch = (_root: string, onEvent: (f: string) => void) => {
        emit = onEvent;
        return { close() {} };
      };

      const watcher = new FileWatcher({
        root: tempDir,
        projectId: "proj",
        store,
        embeddings: mockEmbeddings,
        debounceMs: 20,
        watchFn: fakeWatch,
      });
      watcher.start();

      // Simulate the FS emitting a change for the file.
      emit!("notes.md");

      // Wait past the debounce window for the sync to complete.
      await new Promise((r) => setTimeout(r, 120));

      expect(await store.countChunks("proj")).toBeGreaterThan(0);
      await watcher.stop();
    });

    it("stop() awaits an in-flight sync before resolving (FIX A drain)", async () => {
      const { FileWatcher } = await import("../../src/watcher.js");
      const store = makeMemoryStore();

      await writeFile(join(tempDir, "drain.md"), "# Drain\n\nContent here.\n");

      let emit: ((filename: string) => void) | null = null;
      const fakeWatch = (_root: string, onEvent: (f: string) => void) => {
        emit = onEvent;
        return { close() {} };
      };

      const watcher = new FileWatcher({
        root: tempDir,
        projectId: "drainproj",
        store,
        embeddings: mockEmbeddings,
        debounceMs: 10,
        watchFn: fakeWatch,
      });
      watcher.start();

      // Trigger a change, then wait only past the debounce so the sync is
      // in-flight (not yet finished) when we call stop().
      emit!("drain.md");
      await new Promise((r) => setTimeout(r, 15));

      // stop() MUST drain the in-flight sync. After it resolves, the sync's
      // writes must already be visible — no use-after-close window.
      await watcher.stop();
      expect(await store.countChunks("drainproj")).toBeGreaterThan(0);
    });
  });

  describe("T-8.2: debounceSync pure logic", () => {
    it("exports debounceSync helper", async () => {
      const mod = await import("../../src/watcher.js");
      expect(typeof mod.debounceSync).toBe("function");
    });

    it("debounceSync calls callback once after delay for rapid events", async () => {
      const { debounceSync } = await import("../../src/watcher.js");

      let callCount = 0;
      const callback = async () => {
        callCount++;
      };

      const debounced = debounceSync(callback, 50);

      // Fire 5 rapid events
      debounced("a.md");
      debounced("b.md");
      debounced("c.md");
      debounced("d.md");
      debounced("e.md");

      // Wait for debounce to fire (50ms + buffer)
      await new Promise((r) => setTimeout(r, 150));

      // Should have been called exactly once (last batch wins)
      expect(callCount).toBe(1);
    });

    it("debounceSync batches paths and calls with all pending paths", async () => {
      const { debounceSync } = await import("../../src/watcher.js");

      const seenPaths: string[] = [];
      const callback = async (paths: string[]) => {
        seenPaths.push(...paths);
      };

      const debounced = debounceSync(callback, 50);

      debounced("file1.md");
      debounced("file2.ts");

      await new Promise((r) => setTimeout(r, 150));

      // Both paths should have been batched into the single callback call
      expect(seenPaths).toContain("file1.md");
      expect(seenPaths).toContain("file2.ts");
    });
  });
});
