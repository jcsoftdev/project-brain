import { describe, it, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../../src/commands/bench-mine.js";
import type { BenchQuery } from "../../src/bench/run.js";
import type { MineOptions } from "../../src/bench/mine.js";

const SAMPLE: BenchQuery[] = [{ query: "feat: thing", expect: ["src/thing.ts"] }];

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bench-mine-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("bench mine command", () => {
  it("writes mined queries as JSONL to the --out path", async () => {
    await withTmpDir(async (dir) => {
      const outPath = join(dir, "nested", "queries.jsonl");
      let calledWith: MineOptions | undefined;

      await execute(["--out", outPath], { mine: (opts) => { calledWith = opts; return SAMPLE; } });

      const written = await readFile(outPath, "utf-8");
      expect(written).toBe('{"query":"feat: thing","expect":"src/thing.ts"}\n');
      expect(calledWith?.limit).toBeUndefined();
    });
  });

  it("forwards --limit to mineQueries as a number", async () => {
    await withTmpDir(async (dir) => {
      const outPath = join(dir, "queries.jsonl");
      let calledWith: MineOptions | undefined;

      await execute(["--out", outPath, "--limit", "50"], {
        mine: (opts) => { calledWith = opts; return SAMPLE; },
      });

      expect(calledWith?.limit).toBe(50);
    });
  });

  it("writes nothing and reports zero when no commits survive the filters", async () => {
    await withTmpDir(async (dir) => {
      const outPath = join(dir, "queries.jsonl");
      await execute(["--out", outPath], { mine: () => [] });
      await expect(readFile(outPath, "utf-8")).rejects.toThrow();
    });
  });

  it("forwards --min-survival to mineQueries as a number", async () => {
    await withTmpDir(async (dir) => {
      const outPath = join(dir, "queries.jsonl");
      let calledWith: MineOptions | undefined;

      await execute(["--out", outPath, "--min-survival", "0.75"], {
        mine: (opts) => { calledWith = opts; return SAMPLE; },
      });

      expect(calledWith?.minSurvival).toBe(0.75);
    });
  });

  it("prints the funnel stats mineQueries reports via onStats", async () => {
    await withTmpDir(async (dir) => {
      const outPath = join(dir, "queries.jsonl");

      // A well-behaved mine() invokes onStats before returning, same as the
      // real mineQueries — execute() must not assume it never gets called.
      await execute(["--out", outPath], {
        mine: (opts) => {
          opts.onStats?.({
            scanned: 10,
            afterNoiseSubject: 8,
            afterFileCountBound: 7,
            afterNoisePath: 6,
            afterIndexFilter: 5,
            afterSurvivalFilter: 4,
          });
          return SAMPLE;
        },
      });

      const written = await readFile(outPath, "utf-8");
      expect(written).toBe('{"query":"feat: thing","expect":"src/thing.ts"}\n');
    });
  });
});
