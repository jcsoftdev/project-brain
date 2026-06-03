import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../src/types.js";

function makeMemoryStore(): VectorStore {
  const data = new Map<string, Chunk[]>();
  return {
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
      data.set(project, existing.filter((c) => c.source !== source));
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
  };
}

const mockEmbeddings: EmbeddingClient = {
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
  isAvailable: async () => true,
};

/**
 * T-8.2: maybeStartWatcher helper
 * Tests the testable watcher wiring helper extracted from cli.ts.
 */
describe("maybeStartWatcher", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-serve-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exports maybeStartWatcher function", async () => {
    const mod = await import("../src/serve.js");
    expect(typeof mod.maybeStartWatcher).toBe("function");
  });

  it("returns null when no .project-brain/project.json exists", async () => {
    const { maybeStartWatcher } = await import("../src/serve.js");

    const result = await maybeStartWatcher(tempDir, {
      store: makeMemoryStore(),
      embeddings: mockEmbeddings,
    });

    expect(result).toBeNull();
  });

  it("returns null when .project-brain/ directory exists but no project.json", async () => {
    const { maybeStartWatcher } = await import("../src/serve.js");

    await mkdir(join(tempDir, ".project-brain"), { recursive: true });

    const result = await maybeStartWatcher(tempDir, {
      store: makeMemoryStore(),
      embeddings: mockEmbeddings,
    });

    expect(result).toBeNull();
  });

  it("returns null when project.json is invalid JSON", async () => {
    const { maybeStartWatcher } = await import("../src/serve.js");

    await mkdir(join(tempDir, ".project-brain"), { recursive: true });
    await writeFile(join(tempDir, ".project-brain", "project.json"), "not-valid-json");

    const result = await maybeStartWatcher(tempDir, {
      store: makeMemoryStore(),
      embeddings: mockEmbeddings,
    });

    expect(result).toBeNull();
  });

  it("returns null when project.json has no projectId", async () => {
    const { maybeStartWatcher } = await import("../src/serve.js");

    await mkdir(join(tempDir, ".project-brain"), { recursive: true });
    await writeFile(
      join(tempDir, ".project-brain", "project.json"),
      JSON.stringify({ root: tempDir })
    );

    const result = await maybeStartWatcher(tempDir, {
      store: makeMemoryStore(),
      embeddings: mockEmbeddings,
    });

    expect(result).toBeNull();
  });

  it("returns a FileWatcher instance when project.json is valid", async () => {
    const { maybeStartWatcher } = await import("../src/serve.js");
    const { FileWatcher } = await import("../src/watcher.js");

    await mkdir(join(tempDir, ".project-brain"), { recursive: true });
    await writeFile(
      join(tempDir, ".project-brain", "project.json"),
      JSON.stringify({ projectId: "test-project", root: tempDir })
    );

    const result = await maybeStartWatcher(tempDir, {
      store: makeMemoryStore(),
      embeddings: mockEmbeddings,
    });

    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(FileWatcher);

    // Clean up
    if (result) await result.stop();
  });

  it("the returned watcher has been started (has start/stop methods)", async () => {
    const { maybeStartWatcher } = await import("../src/serve.js");

    await mkdir(join(tempDir, ".project-brain"), { recursive: true });
    await writeFile(
      join(tempDir, ".project-brain", "project.json"),
      JSON.stringify({ projectId: "start-test", root: tempDir })
    );

    const result = await maybeStartWatcher(tempDir, {
      store: makeMemoryStore(),
      embeddings: mockEmbeddings,
    });

    expect(result).not.toBeNull();
    expect(typeof result!.start).toBe("function");
    expect(typeof result!.stop).toBe("function");

    if (result) await result.stop();
  });
});

describe("createShutdownHandler", () => {
  it("stops the watcher then exits 0", async () => {
    const { createShutdownHandler } = await import("../src/serve.js");

    let stopped = false;
    let exitCode: number | null = null;
    const watcher = {
      stop: async () => {
        stopped = true;
      },
    };

    const shutdown = createShutdownHandler(watcher, (code) => {
      exitCode = code;
    });
    await shutdown();

    expect(stopped).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("exits 0 even when there is no watcher", async () => {
    const { createShutdownHandler } = await import("../src/serve.js");

    let exitCode: number | null = null;
    const shutdown = createShutdownHandler(null, (code) => {
      exitCode = code;
    });
    await shutdown();

    expect(exitCode).toBe(0);
  });
});
