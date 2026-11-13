/**
 * Regression: a checkout's index must never hold files from a linked worktree
 * nested inside it, nor files its .gitignore excludes — whichever sync path
 * sees them.
 *
 * Real-world failure this reproduces: the MCP server's recursive file watcher
 * on the main checkout reported every write an agent made under
 * `.claude/worktrees/<name>/`, and the incremental (changedFiles) branch of
 * runSync indexed those paths without applying any ignore rule. The main
 * index ended up with `.claude/worktrees/agent-…/README.md`-style duplicates
 * that the prompt hook then injected as context.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { ManifestStore } from "../../src/indexer/manifest-store.js";
import * as registry from "../../src/store/project-registry.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

function makeStore(): VectorStore & { sources(project: string): string[] } {
  const data = new Map<string, Chunk[]>();
  return {
    sources: (project: string) => [...new Set((data.get(project) ?? []).map((c) => c.source))].sort(),
    ensureTable: async () => {},
    upsert: async (project: string, chunks: Chunk[]) => {
      data.set(project, [...(data.get(project) ?? []), ...chunks]);
    },
    search: async (): Promise<SearchResult[]> => [],
    hybridSearch: async (): Promise<SearchResult[]> => [],
    deleteBySource: async (project: string, source: string) => {
      data.set(project, (data.get(project) ?? []).filter((c) => c.source !== source));
    },
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async (project: string) => (data.get(project) ?? []).length,
    optimize: async () => {},
    batchReplace: async (project: string, sources: string[], chunks: Chunk[]) => {
      const kept = (data.get(project) ?? []).filter((c) => !sources.includes(c.source));
      data.set(project, [...kept, ...chunks]);
    },
    buildIndexes: async () => {},
    getChunkById: async (): Promise<Chunk | null> => null,
    assertDim: async () => {},
  };
}

const mockEmbeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
  isAvailable: async () => true,
};

const PROJECT = "nested-worktree-proj";

async function put(root: string, relPath: string, content: string): Promise<void> {
  await mkdir(join(root, relPath, ".."), { recursive: true });
  await writeFile(join(root, relPath), content);
}

describe("sync keeps nested worktrees and ignored files out of the index", () => {
  let root: string;
  let graph: GraphStore;
  let db: ReturnType<typeof openGraphDb>;
  // runSync stamps the project registry under the real home directory; keep
  // this test's temp roots out of it.
  let registerSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    registerSpy = spyOn(registry, "registerProject").mockResolvedValue(undefined as never);
    root = await mkdtemp(join(tmpdir(), "brain-nested-wt-"));
    db = openGraphDb(":memory:");
    graph = new GraphStore(db);
    await put(root, "src/real.ts", "export function real() {\n  return 1;\n}\n");
    await put(root, ".gitignore", "*.env\nbuild-*/\n");
  });

  afterEach(async () => {
    registerSpy.mockRestore();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function sync(changedFiles?: string[], store = makeStore()) {
    const { runSync } = await import("../../src/commands/sync.js");
    await runSync({ root, projectId: PROJECT, store, embeddings: mockEmbeddings, graph, changedFiles });
    return store;
  }

  it("an incremental sync drops agent worktree paths and gitignored files the watcher reports", async () => {
    await put(root, ".claude/worktrees/agent-x/README.md", "# a whole second copy\n");
    await put(root, ".claude/worktrees/agent-x/src/real.ts", "export function real() {\n  return 2;\n}\n");
    await put(root, "secrets.env", "TOKEN=hunter2\n");
    await put(root, "build-out/bundle.ts", "export const bundled = 1;\n");
    const outside = await mkdtemp(join(tmpdir(), "brain-nested-wt-outside-"));
    await put(outside, "outside-the-root.ts", "export const outside = 1;\n");

    try {
      const store = await sync([
        "src/real.ts",
        ".claude/worktrees/agent-x/README.md",
        ".claude/worktrees/agent-x/src/real.ts",
        "secrets.env",
        "build-out/bundle.ts",
        join(outside, "outside-the-root.ts"),
      ]);

      expect(store.sources(PROJECT)).toEqual(["src/real.ts"]);
      expect(graph.listFiles()).toEqual(["src/real.ts"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("skips a linked worktree nested in a non-ignored directory, on both sync paths, but keeps submodules", async () => {
    // A linked worktree's gitdir carries `commondir`; a submodule's gitdir does
    // not, even when the submodule's own path ends in `worktrees/<name>`.
    await put(root, ".git/worktrees/feature/commondir", "../..\n");
    await put(root, "trees/feature/.git", `gitdir: ${join(root, ".git/worktrees/feature")}\n`);
    await put(root, "trees/feature/src/copy.ts", "export const copy = 1;\n");
    await put(root, ".git/modules/vendor/lib/HEAD", "ref: refs/heads/main\n");
    await put(root, "vendor/lib/.git", "gitdir: ../../.git/modules/vendor/lib\n");
    await put(root, "vendor/lib/lib.ts", "export const lib = 1;\n");
    await put(root, ".git/modules/tools/worktrees/core/HEAD", "ref: refs/heads/main\n");
    await put(root, "tools/worktrees/core/.git", "gitdir: ../../../.git/modules/tools/worktrees/core\n");
    await put(root, "tools/worktrees/core/core.ts", "export const core = 1;\n");

    const kept = [".gitignore", "src/real.ts", "tools/worktrees/core/core.ts", "vendor/lib/lib.ts"];
    const full = await sync();
    expect(full.sources(PROJECT)).toEqual(kept);

    // Same store, so the manifest and store agree and the changed-file branch runs.
    await put(root, "vendor/lib/lib.ts", "export const lib = 2;\n");
    await put(root, "tools/worktrees/core/core.ts", "export const core = 2;\n");
    await sync(
      ["trees/feature/src/copy.ts", "vendor/lib/lib.ts", "tools/worktrees/core/core.ts"],
      full
    );
    expect(full.sources(PROJECT)).toEqual(kept);
    expect(graph.listFiles()).not.toContain("trees/feature/src/copy.ts");
  });

  it("a full sync removes chunks an earlier incremental sync indexed from a nested worktree", async () => {
    const polluted = ".claude/worktrees/agent-x/README.md";
    await put(root, polluted, "# a whole second copy\n");

    const manifest = new ManifestStore(root);
    manifest.upsertFile(polluted, "h", 1, { [`${polluted}#0`]: "c" });
    manifest.close();
    graph.replaceFile(polluted, "markdown", "h", 1, []);

    const { runSync } = await import("../../src/commands/sync.js");
    const store = makeStore();
    await store.upsert(PROJECT, [
      { id: `${polluted}#0`, vector: [], content: "x", source: polluted, module: ".claude", content_hash: "c", updated_at: 0 },
    ]);
    await runSync({ root, projectId: PROJECT, store, embeddings: mockEmbeddings, graph, changedFiles: [] });

    expect(store.sources(PROJECT)).not.toContain(polluted);
    expect(graph.listFiles()).not.toContain(polluted);
    const after = new ManifestStore(root);
    expect(after.listPaths()).not.toContain(polluted);
    after.close();
  });
});
