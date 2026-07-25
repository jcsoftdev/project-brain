// Integration coverage for the 7 native CLI commands (find/callers/callees/
// impact/trace/map/code) added on top of the existing MCP structural tools.
// Spawns the REAL CLI entry point (dev mode, `bun run src/cli.ts <args>`) —
// exercises execute() end-to-end: argv parsing, withGraph's guard states,
// and real stdout/exit-code contracts, not just the DI-level core logic
// already covered by tests/commands/{find,callers,callees,impact,trace,map,code}.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { LanceDbStore } from "../../src/store/lancedb.js";

const CLI_PATH = join(import.meta.dir, "../../src/cli.ts");

function spawnCli(args: string[], cwd: string, env?: Record<string, string>) {
  return Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BRAIN_NO_UPDATE_CHECK: "1", ...env },
  });
}

async function run(args: string[], cwd: string, env?: Record<string, string>) {
  const proc = spawnCli(args, cwd, env);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("structural CLI commands — integration", () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "pb-struct-cli-"));
    await mkdir(join(projectDir, ".project-brain"), { recursive: true });

    // Seed a real graph.db with a small call chain: c -> b -> a.
    const graph = new GraphStore(openGraphDb(join(projectDir, ".project-brain", "graph.db")));
    graph.replaceFile("a.ts", "ts", "hash-a", Date.now(), [
      { name: "a", kind: "function", signature: "function a(): void", start_line: 1, end_line: 3, edges: [] },
    ]);
    graph.resolveEdgesForFile("a.ts");
    graph.replaceFile("b.ts", "ts", "hash-b", Date.now(), [
      { name: "b", kind: "function", signature: "function b(): void", start_line: 5, end_line: 7, edges: [{ dst_name: "a", edge_type: "calls" }] },
    ]);
    graph.resolveEdgesForFile("b.ts");
    graph.replaceFile("c.ts", "ts", "hash-c", Date.now(), [
      { name: "c", kind: "function", signature: "function c(): void", start_line: 9, end_line: 11, edges: [{ dst_name: "b", edge_type: "calls" }] },
    ]);
    graph.resolveEdgesForFile("c.ts");
    graph.close();
  });

  afterAll(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  describe("find", () => {
    it("hit: exits 0 and prints the symbol location", async () => {
      const { stdout, exitCode } = await run(["find", "a"], projectDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("a.ts:1");
    });

    it("miss: exits 0 (empty result is not an error) and prints a not-found message", async () => {
      const { stdout, exitCode } = await run(["find", "doesNotExist"], projectDir);
      expect(exitCode).toBe(0);
      expect(stdout.toLowerCase()).toContain("no symbol");
    });

    it("usage error: missing positional exits 1", async () => {
      const { stderr, exitCode } = await run(["find"], projectDir);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Usage");
    });
  });

  describe("callers", () => {
    it("hit: exits 0 and lists the caller", async () => {
      const { stdout, exitCode } = await run(["callers", "a"], projectDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("b.ts:5");
    });

    it("miss: exits 0 with a no-callers message", async () => {
      const { stdout, exitCode } = await run(["callers", "c"], projectDir);
      expect(exitCode).toBe(0);
      expect(stdout.toLowerCase()).toContain("no callers");
    });
  });

  describe("callees", () => {
    it("hit: exits 0 and lists the callee", async () => {
      const { stdout, exitCode } = await run(["callees", "b"], projectDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("a.ts:1");
    });

    it("miss: exits 0 with a no-callees message", async () => {
      const { stdout, exitCode } = await run(["callees", "a"], projectDir);
      expect(exitCode).toBe(0);
      expect(stdout.toLowerCase()).toContain("no callees");
    });
  });

  describe("impact", () => {
    it("hit: exits 0 and lists transitive callers", async () => {
      const { stdout, exitCode } = await run(["impact", "a"], projectDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("b.ts");
      expect(stdout).toContain("c.ts");
    });

    it("--max-depth 1: only direct caller, not transitive", async () => {
      const { stdout, exitCode } = await run(["impact", "a", "--max-depth", "1"], projectDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("b.ts");
      expect(stdout).not.toContain("c.ts");
    });

    it("miss: exits 0 with a no-transitive-callers message", async () => {
      const { stdout, exitCode } = await run(["impact", "c"], projectDir);
      expect(exitCode).toBe(0);
      expect(stdout.toLowerCase()).toContain("no transitive callers");
    });
  });

  describe("trace", () => {
    it("hit: exits 0 and prints the caller→callee chain", async () => {
      const { stdout, exitCode } = await run(["trace", "c", "a"], projectDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("c.ts:9 c()");
      expect(stdout).toContain("→");
      expect(stdout).toContain("a.ts:1 a()");
    });

    it("no path found: exits 0 (NOT an error) with an informational message", async () => {
      const { stdout, exitCode } = await run(["trace", "a", "c"], projectDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("No path found from a to c");
    });

    it("usage error: missing second positional exits 1", async () => {
      const { stderr, exitCode } = await run(["trace", "a"], projectDir);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Usage");
    });
  });

  describe("map", () => {
    it("exits 0 and prints the ranked map with a files/symbols footer", async () => {
      const { stdout, exitCode } = await run(["map"], projectDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("files");
      expect(stdout).toContain("symbols");
    });
  });

  describe("withGraph guard states (shared across all 6 graph commands — exercised once via find)", () => {
    it("no .project-brain/ found: exits 1 with an actionable init hint", async () => {
      const bareDir = await mkdtemp(join(tmpdir(), "pb-struct-cli-bare-"));
      try {
        const { stderr, exitCode } = await run(["find", "a"], bareDir);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("Not a project-brain project");
        expect(stderr).toContain("project-brain init");
      } finally {
        await rm(bareDir, { recursive: true, force: true });
      }
    });

    it("no graph.db yet: exits 1 with an actionable sync hint", async () => {
      const noGraphDir = await mkdtemp(join(tmpdir(), "pb-struct-cli-nograph-"));
      try {
        await mkdir(join(noGraphDir, ".project-brain"), { recursive: true });
        const { stderr, exitCode } = await run(["find", "a"], noGraphDir);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("No structural index yet");
        expect(stderr).toContain("project-brain sync");
      } finally {
        await rm(noGraphDir, { recursive: true, force: true });
      }
    });

    it("empty graph.db: exits 1 with an actionable sync hint", async () => {
      const emptyGraphDir = await mkdtemp(join(tmpdir(), "pb-struct-cli-empty-"));
      try {
        await mkdir(join(emptyGraphDir, ".project-brain"), { recursive: true });
        openGraphDb(join(emptyGraphDir, ".project-brain", "graph.db")).close();
        const { stderr, exitCode } = await run(["find", "a"], emptyGraphDir);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("Structural index is empty");
        expect(stderr).toContain("project-brain sync");
      } finally {
        await rm(emptyGraphDir, { recursive: true, force: true });
      }
    });
  });

  describe("code — isolated LanceDB (HOME override so DB_PATH resolves under a temp dir)", () => {
    let fakeHome: string;
    let codeProjectDir: string;

    beforeAll(async () => {
      fakeHome = await mkdtemp(join(tmpdir(), "pb-struct-cli-home-"));
      codeProjectDir = await mkdtemp(join(tmpdir(), "pb-struct-cli-codeproj-"));
      await mkdir(join(codeProjectDir, ".project-brain"), { recursive: true });
      await writeFile(
        join(codeProjectDir, ".project-brain", "project.json"),
        JSON.stringify({ projectId: "code-demo" })
      );

      // Seed a real LanceDB table (indexed) under fakeHome/.project-brain/data.
      const store = new LanceDbStore(join(fakeHome, ".project-brain", "data"));
      await store.ensureTable("code-demo", { model: "m", dim: 4 });
      await store.upsert("code-demo", [
        {
          id: "chunk-1",
          vector: [0.1, 0.2, 0.3, 0.4],
          content: "function chargeCard(amount: number) {\n  return gateway.charge(amount);\n}",
          source: "src/billing.ts",
          module: "src",
          content_hash: "hash1",
          updated_at: Date.now(),
          symbol_name: "chargeCard",
          start_line: 10,
          end_line: 13,
        },
      ]);
      await store.buildIndexes("code-demo");
    });

    afterAll(async () => {
      if (fakeHome) await rm(fakeHome, { recursive: true, force: true });
      if (codeProjectDir) await rm(codeProjectDir, { recursive: true, force: true });
    });

    it("hit: exits 0 and prints the matching symbol + snippet", async () => {
      const { stdout, exitCode } = await run(["code", "chargeCard"], codeProjectDir, { HOME: fakeHome });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("chargeCard");
      expect(stdout).toContain("src/billing.ts");
    });

    it("miss: exits 0 with a no-matches message (legitimate empty result)", async () => {
      const { stdout, exitCode } = await run(["code", "nonexistentZzz"], codeProjectDir, { HOME: fakeHome });
      expect(exitCode).toBe(0);
      expect(stdout.toLowerCase()).toContain("no matches");
    });

    it("run before sync: exits 1 with an actionable hint for an unindexed project", async () => {
      const unindexedProjectDir = await mkdtemp(join(tmpdir(), "pb-struct-cli-unindexed-"));
      try {
        const { stderr, exitCode } = await run(["code", "anything"], unindexedProjectDir, { HOME: fakeHome });
        expect(exitCode).toBe(1);
        expect(stderr).toContain("No indexed content for project");
        expect(stderr).toContain("project-brain sync");
      } finally {
        await rm(unindexedProjectDir, { recursive: true, force: true });
      }
    });

    it("usage error: missing query positional exits 1", async () => {
      const { stderr, exitCode } = await run(["code"], codeProjectDir, { HOME: fakeHome });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Usage");
    });
  });
});
