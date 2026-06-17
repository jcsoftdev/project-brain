/**
 * Security: symlink-safe file walk
 *
 * The recursive walk in src/commands/sync.ts uses readdir withFileTypes.
 * On all POSIX platforms and Bun, Dirent.isFile() and Dirent.isDirectory()
 * return FALSE for symlinks (they describe the symlink itself, not the
 * target). This means the walk NEVER follows symlinks — not to files and
 * not to directories. The guard in listAllFiles makes this EXPLICIT by
 * checking !entry.isSymbolicLink() before recursing or collecting.
 *
 * This test verifies both variants:
 *   - symlink-to-file outside root  → NOT indexed
 *   - symlink-to-dir outside root   → NOT descended into, content NOT indexed
 *
 * It also verifies that normal files INSIDE the root ARE indexed (regression
 * guard — the fix must not break the happy path).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

/** Minimal in-memory store — mirrors pattern from tests/commands/sync.test.ts */
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

describe("security: symlink-safe walk", () => {
  let root: string;    // the project root (inside this)
  let outside: string; // a directory OUTSIDE the root

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-sec-root-"));
    outside = await mkdtemp(join(tmpdir(), "brain-sec-outside-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("S2a: symlink-to-file outside root is NOT indexed", async () => {
    // Real file outside root with sensitive content
    const secretPath = join(outside, "secret.txt");
    await writeFile(secretPath, "TOP SECRET external content");

    // A normal file inside the root (should be indexed)
    await writeFile(join(root, "readme.md"), "# Inside root");

    // Symlink inside root pointing to a file OUTSIDE root
    await symlink(secretPath, join(root, "evil-file-link.txt"));

    const store = makeMemoryStore();
    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({ root, projectId: "sec-test", store, embeddings: mockEmbeddings });

    // The walk should have found readme.md but NOT evil-file-link.txt
    const allChunks = store.data.get("sec-test") ?? [];
    const sources = allChunks.map((c) => c.source);

    // Normal file is indexed
    expect(result.scanned).toBeGreaterThan(0);
    const hasInside = sources.some((s) => s.includes("readme.md"));
    expect(hasInside).toBe(true);

    // Symlink target (external file) is NOT indexed under any source name
    const hasSecret = allChunks.some((c) => c.content.includes("TOP SECRET external content"));
    expect(hasSecret).toBe(false);

    // The symlink path itself is NOT a source
    const hasSymlinkSource = sources.some((s) => s.includes("evil-file-link"));
    expect(hasSymlinkSource).toBe(false);
  });

  it("S2b: symlink-to-dir outside root is NOT descended into, content NOT indexed", async () => {
    // Directory outside root with a file in it
    const outsideSubDir = join(outside, "subdir");
    await mkdir(outsideSubDir, { recursive: true });
    await writeFile(join(outsideSubDir, "payload.ts"), "export const SECRET = 'leaked';");

    // A normal file inside the root
    await writeFile(join(root, "app.ts"), "export const FOO = 1;");

    // Symlink inside root pointing to a DIRECTORY outside root
    await symlink(outside, join(root, "evil-dir-link"));

    const store = makeMemoryStore();
    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({ root, projectId: "sec-test-dir", store, embeddings: mockEmbeddings });

    const allChunks = store.data.get("sec-test-dir") ?? [];
    const sources = allChunks.map((c) => c.source);

    // Normal inside file indexed
    expect(result.scanned).toBeGreaterThan(0);
    const hasInside = sources.some((s) => s.includes("app.ts"));
    expect(hasInside).toBe(true);

    // Nothing from the outside directory leaked through the symlink
    const hasLeaked = allChunks.some((c) => c.content.includes("SECRET"));
    expect(hasLeaked).toBe(false);

    // The symlink dir itself is not treated as a directory source
    const hasSymlinkDir = sources.some((s) => s.includes("evil-dir-link"));
    expect(hasSymlinkDir).toBe(false);
  });

  it("S2c: normal files and directories inside root are still indexed", async () => {
    // Nested real directory with files
    const sub = join(root, "src");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "index.ts"), "export const X = 42;");
    await writeFile(join(root, "README.md"), "# Project");

    const store = makeMemoryStore();
    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({ root, projectId: "sec-happy", store, embeddings: mockEmbeddings });

    expect(result.ingested).toBeGreaterThanOrEqual(2);
    const allChunks = store.data.get("sec-happy") ?? [];
    const sources = allChunks.map((c) => c.source);
    expect(sources.some((s) => s.includes("README.md"))).toBe(true);
    expect(sources.some((s) => s.includes("src/index.ts"))).toBe(true);
  });
});
