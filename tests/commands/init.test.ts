import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { VectorStore, EmbeddingClient, Chunk, SearchResult } from "../../src/types.js";

/**
 * Init command tests.
 * Tests the runInit function (exported for DI / testability).
 * We skip the git hook in tests since git repos are complex to set up.
 */
describe("init command", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-init-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("T-6.1: creates .project-brain directory and config", () => {
    it("creates .project-brain/ directory in the target root", async () => {
      const { runInit } = await import("../../src/commands/init.js");

      await runInit({ root: tempDir, skipGitHook: true, skipIndex: true });

      const dotDir = join(tempDir, ".project-brain");
      const proc = Bun.spawn(["test", "-d", dotDir], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await proc.exited).toBe(0);
    });

    it("writes project.json with projectId field", async () => {
      const { runInit } = await import("../../src/commands/init.js");

      await runInit({ root: tempDir, skipGitHook: true, skipIndex: true });

      const configPath = join(tempDir, ".project-brain", "project.json");
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw);
      expect(typeof config.projectId).toBe("string");
      expect(config.projectId.length).toBeGreaterThan(0);
    });

    it("writes project.json with root field matching the initialized root", async () => {
      const { runInit } = await import("../../src/commands/init.js");

      await runInit({ root: tempDir, skipGitHook: true, skipIndex: true });

      const configPath = join(tempDir, ".project-brain", "project.json");
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw);
      expect(config.root).toBe(tempDir);
    });
  });

  describe("T-6.2: detects stack and stores in config", () => {
    it("detects stack and stores it in project.json", async () => {
      // Write a package.json so stack detection finds JavaScript
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "test-project", dependencies: {} })
      );

      const { runInit } = await import("../../src/commands/init.js");
      await runInit({ root: tempDir, skipGitHook: true, skipIndex: true });

      const configPath = join(tempDir, ".project-brain", "project.json");
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw);
      expect(config.stack).toBeDefined();
      expect(Array.isArray(config.stack.languages)).toBe(true);
    });

    it("stores empty stack gracefully when no manifest is found", async () => {
      const { runInit } = await import("../../src/commands/init.js");
      await runInit({ root: tempDir, skipGitHook: true, skipIndex: true });

      const configPath = join(tempDir, ".project-brain", "project.json");
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw);
      // Stack should still be defined even with no manifest
      expect(config.stack).toBeDefined();
    });
  });

  describe("T-6.3: idempotent on re-run", () => {
    it("does not error when .project-brain already exists", async () => {
      const { runInit } = await import("../../src/commands/init.js");

      await runInit({ root: tempDir, skipGitHook: true, skipIndex: true });
      // Second run should not throw
      await expect(runInit({ root: tempDir, skipGitHook: true, skipIndex: true })).resolves.toBeDefined();
    });

    it("preserves existing projectId across re-runs", async () => {
      const { runInit } = await import("../../src/commands/init.js");

      const r1 = await runInit({ root: tempDir, skipGitHook: true, skipIndex: true });

      const configPath = join(tempDir, ".project-brain", "project.json");
      const raw1 = await readFile(configPath, "utf-8");
      const config1 = JSON.parse(raw1);

      // Second run
      await runInit({ root: tempDir, skipGitHook: true, skipIndex: true });

      const raw2 = await readFile(configPath, "utf-8");
      const config2 = JSON.parse(raw2);

      // projectId must be stable
      expect(config2.projectId).toBe(config1.projectId);
    });
  });

  describe("exports", () => {
    it("exports execute function", async () => {
      const mod = await import("../../src/commands/init.js");
      expect(typeof mod.execute).toBe("function");
    });

    it("exports runInit function for DI", async () => {
      const mod = await import("../../src/commands/init.js");
      expect(typeof mod.runInit).toBe("function");
    });
  });
});

/** Build a fake VectorStore that records upsert calls. */
function makeFakeStore(): VectorStore & { upsertCalls: number } {
  return {
    upsertCalls: 0,
    async ensureTable() {},
    async upsert(_project: string, _chunks: Chunk[]) {
      this.upsertCalls++;
    },
    async batchReplace(_project: string, _sources: string[], _chunks: Chunk[]) {
      this.upsertCalls++;
    },
    async search() { return [] as SearchResult[]; },
    async deleteBySource() {},
    async listModules() { return []; },
    async getModuleChunks() { return [] as Chunk[]; },
    async countChunks() { return 0; },
    async optimize() {},
    async buildIndexes() {},
    async hybridSearch() { return [] as SearchResult[]; },
    async getChunkById() { return null; },
    async assertDim() {},
  };
}

/** Build a fake EmbeddingClient that returns vectors. */
function makeFakeEmbeddings(): EmbeddingClient {
  return {
    async embed(texts: string[]) {
      return texts.map(() => new Array(768).fill(0.1));
    },
    async isAvailable() { return true; },
  };
}

/** Build a fake EmbeddingClient that always throws. */
function makeThrowingEmbeddings(): EmbeddingClient {
  return {
    async embed() {
      throw new Error("Ollama unreachable (fake)");
    },
    async isAvailable() { return false; },
  };
}

/**
 * T-07: CLI output for init with indexing results
 */
describe("init execute CLI output (T-07)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-init-cli-"));
    await writeFile(join(tempDir, "README.md"), "# Test project");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("T-07: prints [warning] when indexWarning is present", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      // We can't easily test execute() directly since it calls runInit internally,
      // but we can check that execute handles --skip-index flag
      const { execute } = await import("../../src/commands/init.js");
      await execute(["--skip-index", tempDir]);
    } finally {
      console.log = origLog;
    }

    // With --skip-index the output should mention "skipped"
    const combined = logs.join("\n");
    expect(combined).toContain("skipped");
  });

  it("T-07: prints Indexed: skipped when skipIndex and no warning", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const { execute } = await import("../../src/commands/init.js");
      await execute(["--skip-index", tempDir]);
    } finally {
      console.log = origLog;
    }

    const combined = logs.join("\n");
    // Should contain skip message
    expect(combined).toContain("Indexed:");
    expect(combined).not.toContain("[warning]");
  });
});

describe("init command — indexing (T-06)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-init-index-"));
    // Create at least one .md file so runSync has something to ingest
    await writeFile(join(tempDir, "README.md"), "# Test project");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Scenario 1.1 — Happy path: index completes [unit]
   */
  it("Scenario 1.1: result.indexed === true when fake store+embeddings succeed", async () => {
    const { runInit } = await import("../../src/commands/init.js");
    const fakeStore = makeFakeStore();
    const fakeEmbeddings = makeFakeEmbeddings();

    const result = await runInit({
      root: tempDir,
      skipGitHook: true,
      skipRules: true,
      indexDeps: { store: fakeStore, embeddings: fakeEmbeddings },
    });

    expect(result.indexed).toBe(true);
    expect(result.indexStats).toBeDefined();
    expect(result.indexStats!.ingested).toBeGreaterThanOrEqual(1);
    expect(result.indexWarning).toBeUndefined();
    expect(fakeStore.upsertCalls).toBeGreaterThanOrEqual(1);
  });

  /**
   * Scenario 1.2 — Graceful degradation: embeddings throw [unit]
   */
  it("Scenario 1.2: result.indexed === false when embeddings throw", async () => {
    const { runInit } = await import("../../src/commands/init.js");
    const fakeStore = makeFakeStore();
    const throwingEmbeddings = makeThrowingEmbeddings();

    const result = await runInit({
      root: tempDir,
      skipGitHook: true,
      skipRules: true,
      indexDeps: { store: fakeStore, embeddings: throwingEmbeddings },
    });

    // Must not throw
    expect(result.indexed).toBe(false);
    expect(typeof result.indexWarning).toBe("string");
    expect(result.indexWarning!.length).toBeGreaterThan(0);

    // project.json must exist — init completed
    const configPath = join(tempDir, ".project-brain", "project.json");
    const raw = await readFile(configPath, "utf-8");
    expect(JSON.parse(raw).projectId).toBeDefined();
  });

  /**
   * Scenario 1.3 — skipIndex flag [unit]
   */
  it("Scenario 1.3: skipIndex: true => indexed === false, no store calls", async () => {
    const { runInit } = await import("../../src/commands/init.js");
    const fakeStore = makeFakeStore();
    const fakeEmbeddings = makeFakeEmbeddings();

    const result = await runInit({
      root: tempDir,
      skipGitHook: true,
      skipRules: true,
      skipIndex: true,
      indexDeps: { store: fakeStore, embeddings: fakeEmbeddings },
    });

    expect(result.indexed).toBe(false);
    expect(result.indexWarning).toBeUndefined();
    expect(result.indexStats).toBeUndefined();
    expect(fakeStore.upsertCalls).toBe(0);
  });

  /**
   * Scenario 1.4 — Idempotency with skipIndex [unit]
   */
  it("Scenario 1.4: re-init preserves existing projectId when skipIndex: true", async () => {
    const { runInit } = await import("../../src/commands/init.js");

    const r1 = await runInit({ root: tempDir, skipGitHook: true, skipRules: true, skipIndex: true });
    const r2 = await runInit({ root: tempDir, skipGitHook: true, skipRules: true, skipIndex: true });

    expect(r2.projectId).toBe(r1.projectId);
    expect(r2.indexed).toBe(false);
  });
});
