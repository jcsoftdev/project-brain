import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { pruneCommand } from "../../src/commands/prune.js";
import { compactCommand } from "../../src/commands/compact.js";
import { benchCommand } from "../../src/commands/bench.js";
import { PROJECTS_FILE } from "../../src/store/project-registry.js";

const DIM = 8;

/**
 * In-process coverage for the maintenance commands.
 *
 * The end-to-end lifecycle suite drives these through a spawned CLI, which
 * proves they work but contributes NO coverage: the instrumenter only sees the
 * test process, never the child. These exercise the same functions directly.
 */
describe("maintenance commands", () => {
  let dataDir: string;
  let dbPath: string;
  let logs: string[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "pb-maint-"));
    dbPath = join(dataDir, "data");
    await mkdir(dbPath, { recursive: true });
    logs = [];
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
  });

  afterEach(async () => {
    (console.log as any).mockRestore?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  const out = () => logs.join("\n");

  async function seedTable(project: string) {
    const store = new LanceDbStore(dbPath);
    await store.ensureTable(project, { model: "fake", dim: DIM });
    const chunks = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i}`,
      vector: new Array(DIM).fill(i),
      content: `function f${i}() {}`,
      source: `src/f${i}.ts`,
      module: "root",
      content_hash: `h${i}`,
      updated_at: 1,
    }));
    await store.batchReplace(project, chunks.map((c) => c.source), chunks);
    return store;
  }

  async function writeRegistry(entries: Record<string, unknown>) {
    await writeFile(join(dataDir, PROJECTS_FILE), JSON.stringify(entries), "utf-8");
  }

  describe("pruneCommand", () => {
    it("reports an unattributed table and refuses to delete it", async () => {
      await seedTable("ghost");
      await writeRegistry({});

      const report = await pruneCommand({ dataDir, dbPath, dryRun: true });

      expect(report.deleted).toEqual([]);
      expect(report.skipped.map((c) => c.reason)).toEqual(["unknown-provenance"]);
      expect(out()).toContain("Unattributed tables");
    });

    it("holds a recently-missing root inside the grace window", async () => {
      await seedTable("held");
      await writeRegistry({
        held: { root: "/gone", updatedAt: 1, missingSince: Date.now() - 1000 },
      });

      const report = await pruneCommand({ dataDir, dbPath, dryRun: true });

      expect(report.deleted).toEqual([]);
      expect(out()).toContain("Holding: held");
    });

    it("reports what a long-missing project would lose, without deleting on dryRun", async () => {
      await seedTable("dead");
      await writeRegistry({
        dead: {
          root: "/gone",
          updatedAt: 1,
          missingSince: Date.now() - 30 * 24 * 60 * 60 * 1000,
        },
      });

      const report = await pruneCommand({ dataDir, dbPath, dryRun: true });

      expect(report.deleted.map((c) => c.project)).toEqual(["dead"]);
      expect(out()).toContain("Would delete: dead");
      expect(await new LanceDbStore(dbPath).listTables()).toContain("dead_chunks");
    });

    it("actually drops the table when not a dry run", async () => {
      await seedTable("dead");
      await writeRegistry({
        dead: {
          root: "/gone",
          updatedAt: 1,
          missingSince: Date.now() - 30 * 24 * 60 * 60 * 1000,
        },
      });

      await pruneCommand({ dataDir, dbPath });

      expect(await new LanceDbStore(dbPath).listTables()).not.toContain("dead_chunks");
      expect(out()).toContain("Deleted: dead");
    });

    it("says so plainly when there is nothing to do", async () => {
      await writeRegistry({});
      const report = await pruneCommand({ dataDir, dbPath, dryRun: true });
      expect(report.deleted).toEqual([]);
      expect(out()).toContain("Nothing to prune");
    });
  });

  describe("compactCommand", () => {
    it("reports the before and after size of the table", async () => {
      await seedTable("proj");

      await compactCommand("proj", dbPath);

      expect(out()).toContain("Compacting proj");
      expect(out()).toMatch(/GB\s+->\s+/);
    });

    it("errors instead of pretending when the project has no table", async () => {
      const prevCode = process.exitCode;
      const errors: string[] = [];
      const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        errors.push(a.join(" "));
      });

      try {
        await compactCommand("does-not-exist", dbPath);

        expect(errors.join("\n")).toContain("no table found");
        expect(process.exitCode).toBe(1);
      } finally {
        // Bun treats `process.exitCode = undefined` as a no-op, so restoring the
        // captured value verbatim leaves the 1 in place and the whole run exits
        // non-zero reporting zero failures. The restore also has to survive a
        // failing expect() above, hence the finally.
        process.exitCode = prevCode ?? 0;
        spy.mockRestore();
      }
    });
  });

  describe("benchCommand", () => {
    it("scores queries and reports the configuration it measured", async () => {
      await seedTable("proj");
      const queriesPath = join(dataDir, "q.jsonl");
      await writeFile(
        queriesPath,
        [
          '{"query":"f1","expect":"src/f1.ts"}',
          '{"query":"nothing like this exists","expect":"src/absent.ts"}',
        ].join("\n"),
        "utf-8"
      );

      const report = await benchCommand({ project: "proj", queriesPath, dbPath });

      expect(report.results).toHaveLength(2);
      expect(out()).toContain("model");
      expect(out()).toContain("recall@1");
      expect(out()).toContain("MRR");
      // A miss must be named, not just counted — the name is the actionable part.
      expect(out()).toContain("src/absent.ts");
    });

    it("returns an empty report for an empty ground-truth file", async () => {
      const queriesPath = join(dataDir, "empty.jsonl");
      await writeFile(queriesPath, "# nothing here\n", "utf-8");

      const report = await benchCommand({ project: "proj", queriesPath, dbPath });

      expect(report.results).toEqual([]);
      expect(out()).toContain("No queries to run");
    });
  });
});
