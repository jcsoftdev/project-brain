import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoCompact,
  autoCompactLimits,
  defaultAutoCompactDeps,
  dirSize,
  lsofTableHolders,
  shouldCompact,
  summarize,
  tablePath,
  type AutoCompactDeps,
  type CompactFacts,
  type TableInfo,
} from "../../src/commands/auto-compact.js";
import { compactCommand } from "../../src/commands/compact.js";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { Chunk } from "../../src/types.js";

const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const NOW = 1_000_000_000_000;
const limits = { minBytes: 256 * MB, minIntervalMs: 24 * HOUR, quietMs: 10 * 60 * 1000, maxTables: 2, budgetMs: 60_000, retentionMs: 1 };

const eligible: CompactFacts = {
  sizeBytes: 500 * MB,
  lastModifiedMs: NOW - HOUR,
  lastCompactedAt: null,
  now: NOW,
  holders: [],
  ownProject: false,
};

describe("shouldCompact", () => {
  const cases: [string, Partial<CompactFacts>, boolean][] = [
    ["over threshold and idle", {}, true],
    ["exactly at the threshold", { sizeBytes: 256 * MB }, true],
    ["below the size threshold", { sizeBytes: 255 * MB }, false],
    ["compacted within the interval", { lastCompactedAt: NOW - 2 * HOUR }, false],
    ["compacted longer ago than the interval", { lastCompactedAt: NOW - 25 * HOUR }, true],
    ["committed to a minute ago", { lastModifiedMs: NOW - 60_000 }, false],
    ["a process holds it", { holders: [4242] }, false],
    ["holder check failed", { holders: null }, false],
    ["it is the running session's project", { ownProject: true }, false],
  ];
  for (const [name, patch, expected] of cases) {
    it(name, () => {
      expect(shouldCompact({ ...eligible, ...patch }, limits).compact).toBe(expected);
    });
  }
});

describe("lsofTableHolders", () => {
  const run = (r: Record<string, unknown>) => lsofTableHolders("/t", 1, (() => ({ stderr: "", stdout: "", status: 1, ...r })) as any);

  it("reads pids, drops its own", () => {
    expect(run({ status: 0, stdout: "p10\np1\np10\n" })).toEqual([10]);
  });
  it("treats a clean exit 1 with no output as free", () => {
    expect(run({})).toEqual([]);
  });
  it("treats a spawn error, a signal, stderr noise or an odd status as unknown", () => {
    expect(run({ error: new Error("ENOENT") })).toBeNull();
    expect(run({ signal: "SIGTERM", status: null })).toBeNull();
    expect(run({ stderr: "lsof: WARNING" })).toBeNull();
    expect(run({ status: 2 })).toBeNull();
    expect(run({ status: 1, stdout: "p10\n" })).toBeNull();
  });
});

function fakeDeps(tables: TableInfo[], over: Partial<AutoCompactDeps> = {}) {
  const compacted: string[] = [];
  let record: Record<string, number> = {};
  let clock = NOW;
  const deps: AutoCompactDeps = {
    limits,
    ownProject: null,
    now: () => clock,
    listTables: async () => tables,
    holders: () => [],
    compact: async (p) => {
      compacted.push(p);
      return 100 * MB;
    },
    readRecord: async () => record,
    writeRecord: async (r) => {
      record = { ...r };
    },
    ...over,
  };
  return { deps, compacted, tick: (ms: number) => (clock += ms), getRecord: () => record };
}

const table = (project: string, mb: number): TableInfo => ({ project, sizeBytes: mb * MB, lastModifiedMs: NOW - HOUR });

describe("autoCompact", () => {
  it("compacts largest first and stops at the per-run cap", async () => {
    const f = fakeDeps([table("a", 300), table("b", 900), table("c", 600)]);
    const r = await autoCompact(f.deps);
    expect(f.compacted).toEqual(["b", "c"]);
    expect(r.reclaimedBytes).toBe(200 * MB);
    expect(Object.keys(f.getRecord()).sort()).toEqual(["b", "c"]);
  });

  it("stops between tables once the wall budget is spent", async () => {
    const f = fakeDeps([table("a", 900), table("b", 800)]);
    f.deps.compact = async (p) => {
      f.compacted.push(p);
      f.tick(61_000);
      return MB;
    };
    await autoCompact(f.deps);
    expect(f.compacted).toEqual(["a"]);
  });

  it("skips held, unreadable-holder, own-project, small and recently compacted tables", async () => {
    const f = fakeDeps(
      [table("held", 900), table("unknown", 800), table("own", 700), table("small", 10), table("recent", 600), table("free", 500)],
      {
        ownProject: "own",
        holders: (p) => (p === "held" ? [7] : p === "unknown" ? null : []),
        readRecord: async () => ({ recent: NOW - HOUR }),
      }
    );
    await autoCompact(f.deps);
    expect(f.compacted).toEqual(["free"]);
  });

  it("treats a throwing holder check as in use", async () => {
    const f = fakeDeps([table("a", 900)], {
      holders: () => {
        throw new Error("boom");
      },
    });
    await autoCompact(f.deps);
    expect(f.compacted).toEqual([]);
  });

  it("swallows a failing table and still compacts the next", async () => {
    const f = fakeDeps([table("bad", 900), table("good", 800)]);
    f.deps.compact = async (p) => {
      if (p === "bad") throw new Error("another process is doing maintenance");
      f.compacted.push(p);
      return MB;
    };
    const r = await autoCompact(f.deps);
    expect(r.compacted).toEqual(["good"]);
    expect(f.getRecord().bad).toBeUndefined();
  });

  it("never throws, whatever fails", async () => {
    const f = fakeDeps([], {
      listTables: async () => {
        throw new Error("no data dir");
      },
      readRecord: async () => {
        throw new Error("corrupt");
      },
    });
    expect(await autoCompact(f.deps)).toEqual({ compacted: [], reclaimedBytes: 0 });
  });

  it("is silent unless it reclaimed something", () => {
    expect(summarize({ compacted: ["a"], reclaimedBytes: 0 })).toBeNull();
    expect(summarize({ compacted: [], reclaimedBytes: 0 })).toBeNull();
    expect(summarize({ compacted: ["a", "b"], reclaimedBytes: 1.5e9 })).toBe(
      "project-brain: reclaimed 1.50 GB from 2 index(es)"
    );
  });
});

describe("autoCompactLimits", () => {
  it("defaults and env overrides", () => {
    expect(autoCompactLimits()).toMatchObject({ minBytes: 256 * MB, minIntervalMs: 24 * HOUR, maxTables: 2, budgetMs: 60_000 });
    process.env.BRAIN_AUTO_COMPACT_MAX_TABLES = "5";
    try {
      expect(autoCompactLimits().maxTables).toBe(5);
    } finally {
      delete process.env.BRAIN_AUTO_COMPACT_MAX_TABLES;
    }
  });
});

describe("with a real LanceDB table", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-autocompact-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const chunk = (i: number): Chunk => ({
    id: `p::${i}`,
    vector: new Array(VECTOR_DIM).fill(i % 7),
    content: "x".repeat(2000) + i,
    source: `f${i % 5}.md`,
    module: "core",
    content_hash: `h${i}`,
    updated_at: Date.now(),
  });

  async function makeGarbage(): Promise<string> {
    const store = new LanceDbStore(dir);
    await store.ensureTable("garbage");
    for (let round = 0; round < 12; round++) {
      await store.upsert("garbage", Array.from({ length: 40 }, (_, i) => chunk(i + round)));
    }
    await store.deleteBySources("garbage", ["f0.md", "f1.md"]);
    // The retention window is measured from commit time; let the garbage age past it.
    await Bun.sleep(50);
    return tablePath(dir, "garbage");
  }

  it("reclaims disk and leaves the data queryable", async () => {
    const path = await makeGarbage();
    const before = await dirSize(path);

    const deps = defaultAutoCompactDeps({ dbPath: dir, dataDir: dir, ownProject: null, holders: () => [] });
    deps.limits = { ...limits, minBytes: 1, quietMs: 0, retentionMs: 1 };
    const result = await autoCompact(deps);

    expect(result.compacted).toEqual(["garbage"]);
    expect(await dirSize(path)).toBeLessThan(before);
    const record = JSON.parse(await readFile(join(dir, "compaction.json"), "utf-8"));
    expect(typeof record.garbage).toBe("number");

    const reopened = new LanceDbStore(dir);
    const rows = await (await (reopened as any).getTable("garbage")).countRows();
    expect(rows).toBeGreaterThan(0);

    // second run inside the interval does nothing
    expect((await autoCompact(deps)).compacted).toEqual([]);
  });

  it("manual compact refuses while a holder exists or the check is unreadable, and --force proceeds", async () => {
    const path = await makeGarbage();
    const before = await dirSize(path);

    for (const holders of [() => [4242], () => null]) {
      process.exitCode = 0;
      await compactCommand("garbage", dir, { holders });
      expect(process.exitCode).toBe(1);
      expect(await dirSize(path)).toBe(before);
    }

    process.exitCode = 0;
    await compactCommand("garbage", dir, { force: true, holders: () => [4242] });
    expect(process.exitCode).toBe(0);
  });
});

describe("compact --help", () => {
  it("prints usage, exits 0 and compacts nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "pb-help-"));
    try {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../../src/cli.ts"), "compact", "--help"], {
        cwd: home,
        env: { ...process.env, HOME: home, BRAIN_NO_SKILL_REFRESH: "1", BRAIN_NO_UPDATE_CHECK: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).toContain("Usage: project-brain compact");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
