import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

/**
 * REGRESSION GUARD — an OKF bundle is tracked in git (that is the point of the
 * format), so the regular indexer walks it like any other markdown. Both
 * pipelines key chunks by the same repo-relative path, so before this guard a
 * plain `sync` chunked the bundle raw and replaced the curated projection —
 * frontmatter as prose, managed block included, module derived from the
 * directory. The git hook runs sync on commit, so committing the bundle broke
 * it every single time.
 *
 * Unit tests could not catch this: each pipeline was correct on its own. Only
 * running the real indexer over a real bundle shows the collision.
 */
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
    listModules: async (project) => [...new Set((data.get(project) ?? []).map((c) => c.module))].sort(),
    getModuleChunks: async (project, module) =>
      (data.get(project) ?? []).filter((c) => c.module === module),
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
  dim: VECTOR_DIM,
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
  isAvailable: async () => true,
};

const CONCEPT = [
  "---",
  "type: Gotcha",
  "title: Language.load ignores /$bunfs",
  "tags: [parser, bun]",
  "---",
  "",
  "# Why",
  "The emscripten loader bypasses the virtual filesystem.",
  "",
  "<!-- project-brain:start -->",
  "| Symbol | Range |",
  "| `loadGrammar` | L14-24 |",
  "<!-- project-brain:end -->",
].join("\n");

describe("runSync over a tracked OKF bundle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-sync-okf-"));
    await mkdir(join(root, ".project-brain"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function sync(store: VectorStore) {
    const { runSync } = await import("../../src/commands/sync.js");
    return runSync({ root, projectId: "p", store, embeddings: mockEmbeddings });
  }

  it("files bundle concepts under the okf module, not the directory-derived one", async () => {
    const store = makeMemoryStore();
    await mkdir(join(root, "okf", "gotchas"), { recursive: true });
    await writeFile(join(root, "okf", "gotchas", "bunfs.md"), CONCEPT);

    await sync(store);

    const chunks = store.data.get("p") ?? [];
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.module === "okf")).toBe(true);
    expect(chunks.every((c) => c.source === "okf/gotchas/bunfs.md")).toBe(true);
  });

  it("indexes the curated projection, not the raw file", async () => {
    const store = makeMemoryStore();
    await mkdir(join(root, "okf", "gotchas"), { recursive: true });
    await writeFile(join(root, "okf", "gotchas", "bunfs.md"), CONCEPT);

    await sync(store);

    const text = (store.data.get("p") ?? []).map((c) => c.content).join("\n");
    // The type label is added by the projection...
    expect(text).toContain("[Gotcha] Language.load ignores /$bunfs");
    // ...the raw frontmatter delimiters are not indexed as prose...
    expect(text).not.toContain("type: Gotcha");
    // ...and the machine-managed block is stripped.
    expect(text).not.toContain("loadGrammar");
  });

  it("does not index reserved navigation or reference material from the bundle", async () => {
    const store = makeMemoryStore();
    await mkdir(join(root, "okf", "references"), { recursive: true });
    await writeFile(join(root, "okf", "index.md"), "# Bundle\n* [g](gotchas/)");
    await writeFile(join(root, "okf", "log.md"), "# Log\n## 2026-07-29\n* **Creation**: Init.");
    await writeFile(join(root, "okf", "references", "upstream.md"), "# Upstream notes");

    await sync(store);

    expect(store.data.get("p") ?? []).toHaveLength(0);
  });

  it("removes chunks a bundle file was indexed with before the router learned to skip it", async () => {
    // The real sequence, found by auditing this repo's own bundle: okf/log.md
    // was indexed as raw markdown before routing existed, and every later sync
    // took the routed-skip branch — which updated the manifest but never
    // deleted the chunks. A changelog stayed in search results forever.
    const store = makeMemoryStore();
    await mkdir(join(root, "okf"), { recursive: true });
    await writeFile(join(root, "okf", "log.md"), "# Log\n## 2026-07-29\n* **Creation**: Init.");

    // Bundle configured elsewhere → this file takes the ordinary markdown path.
    const { runSync } = await import("../../src/commands/sync.js");
    await runSync({ root, projectId: "p", store, embeddings: mockEmbeddings, okfDir: "elsewhere" });
    expect((store.data.get("p") ?? []).some((c) => c.source === "okf/log.md")).toBe(true);

    // Now it is inside the bundle, and its content changed so the hash-skip
    // short-circuit does not hide the routing decision.
    await writeFile(join(root, "okf", "log.md"), "# Log\n## 2026-07-30\n* **Update**: Second entry.");
    await sync(store);

    expect((store.data.get("p") ?? []).filter((c) => c.source === "okf/log.md")).toEqual([]);
  });

  it("still indexes ordinary markdown outside the bundle the normal way", async () => {
    const store = makeMemoryStore();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "readme.md"), "# Docs\nOrdinary prose that must stay indexed.");

    await sync(store);

    const chunks = store.data.get("p") ?? [];
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.module === "docs")).toBe(true);
  });

  it("leaves a directory that merely shares the bundle's prefix on the normal path", async () => {
    const store = makeMemoryStore();
    await mkdir(join(root, "okf-drafts"), { recursive: true });
    await writeFile(join(root, "okf-drafts", "notes.md"), "# Drafts\nNot a bundle.");

    await sync(store);

    const chunks = store.data.get("p") ?? [];
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.module === "okf-drafts")).toBe(true);
  });
});
