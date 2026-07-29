import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Chunk, EmbeddingClient, VectorStore } from "../../src/types.js";

function fakeStore(): VectorStore {
  return {
    ensureTable: async () => {},
    upsert: async () => {},
    batchReplace: async (_p: string, _s: string[], _c: Chunk[]) => {},
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
  } as unknown as VectorStore;
}

const fakeEmbeddings = {
  dim: 4,
  model: "fake",
  embed: async (texts: string[]) => texts.map(() => [0, 0, 0, 0]),
  isAvailable: async () => true,
} as unknown as EmbeddingClient;

describe("okf command", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-okf-cmd-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(relPath: string, content: string): Promise<void> {
    const full = join(root, relPath);
    await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await writeFile(full, content);
  }

  const concept = (type: string, title: string) =>
    ["---", `type: ${type}`, `title: ${title}`, "---", "", "# Why", "Because."].join("\n");

  describe("runOkfValidate", () => {
    it("reports a conforming bundle as ok", async () => {
      const { runOkfValidate } = await import("../../src/commands/okf.js");
      await write("decisions/a.md", concept("Decision", "A"));

      const result = await runOkfValidate(root);

      expect(result.ok).toBe(true);
      expect(result.output).toContain("1 concept");
    });

    it("lists each conformance issue with its path and rule", async () => {
      const { runOkfValidate } = await import("../../src/commands/okf.js");
      await write("decisions/a.md", concept("Decision", "A"));
      await write("decisions/bad.md", "# No frontmatter");

      const result = await runOkfValidate(root);

      expect(result.ok).toBe(false);
      expect(result.output).toContain("decisions/bad.md");
      expect(result.output).toContain("frontmatter-required");
    });

    it("reports a missing bundle directory as a plain message, not a crash", async () => {
      const { runOkfValidate } = await import("../../src/commands/okf.js");

      const result = await runOkfValidate(join(root, "absent"));

      expect(result.ok).toBe(false);
      expect(result.output).toContain("does not exist");
    });
  });

  describe("runOkfSync", () => {
    it("keys concepts by their repo-relative path, matching what a plain sync writes", async () => {
      const { runOkfSync } = await import("../../src/commands/okf.js");
      const captured: Chunk[] = [];
      const store = {
        ...fakeStore(),
        batchReplace: async (_p: string, _s: string[], chunks: Chunk[]) => {
          captured.push(...chunks);
        },
      } as unknown as VectorStore;
      await write("okf/decisions/a.md", concept("Decision", "A"));

      // The command layer must forward the repo root. Without it the ids come
      // out bundle-relative ("decisions/a.md") while runSync writes
      // "okf/decisions/a.md" for the same file, and the two pipelines delete
      // each other's chunks on every run.
      await runOkfSync(join(root, "okf"), {
        project: "p",
        store,
        embeddings: fakeEmbeddings,
        repoRoot: root,
      });

      expect(captured.length).toBeGreaterThan(0);
      expect(captured.every((c) => c.source === "okf/decisions/a.md")).toBe(true);
    });

    it("summarizes what it indexed", async () => {
      const { runOkfSync } = await import("../../src/commands/okf.js");
      await write("decisions/a.md", concept("Decision", "A"));
      await write("gotchas/b.md", concept("Gotcha", "B"));

      const output = await runOkfSync(root, {
        project: "p",
        store: fakeStore(),
        embeddings: fakeEmbeddings,
        repoRoot: root,
      });

      expect(output).toContain("2 concepts");
    });

    it("surfaces conformance issues alongside the summary so they are not silently skipped", async () => {
      const { runOkfSync } = await import("../../src/commands/okf.js");
      await write("decisions/a.md", concept("Decision", "A"));
      await write("decisions/bad.md", "# No frontmatter");

      const output = await runOkfSync(root, {
        project: "p",
        store: fakeStore(),
        embeddings: fakeEmbeddings,
        repoRoot: root,
      });

      expect(output).toContain("1 concept");
      expect(output).toContain("decisions/bad.md");
      expect(output).toContain("not indexed");
    });
  });
});
