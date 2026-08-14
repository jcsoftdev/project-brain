import { describe, it, expect } from "bun:test";
import { classifyTables, pruneOrphans } from "../../src/store/prune.js";

const GRACE = 7 * 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

describe("classifyTables", () => {
  it("ignores a table whose project root is present", () => {
    const out = classifyTables(
      ["kanbai_chunks"],
      { kanbai: { root: "/repos/kanbai", updatedAt: 1 } },
      { now: NOW, graceMs: GRACE, rootExists: () => true }
    );
    expect(out).toEqual([]);
  });

  it("marks a long-missing root eligible for automatic deletion", () => {
    const out = classifyTables(
      ["dead_chunks"],
      { dead: { root: "/gone", updatedAt: 1, missingSince: NOW - GRACE - 1 } },
      { now: NOW, graceMs: GRACE, rootExists: () => false }
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      project: "dead",
      table: "dead_chunks",
      reason: "root-missing",
      eligible: true,
    });
  });

  it("holds a recently-missing root inside the grace window", () => {
    // An unmounted volume looks exactly like a deleted repo. The grace window
    // is the only thing separating them, so it must gate deletion, not reporting.
    const out = classifyTables(
      ["maybe_chunks"],
      { maybe: { root: "/volumes/ext", updatedAt: 1, missingSince: NOW - 1000 } },
      { now: NOW, graceMs: GRACE, rootExists: () => false }
    );
    expect(out[0]).toMatchObject({ reason: "root-missing", eligible: false });
  });

  it("never makes a table with no registry entry eligible", () => {
    // Real case: `sessions` is a LIVE project with a running server and a
    // local graph.db, but predates the registry — it has no entry at all.
    // Treating "unregistered" as "orphan" would delete a working index.
    const out = classifyTables(["sessions_chunks"], {}, {
      now: NOW,
      graceMs: GRACE,
      rootExists: () => false,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      project: "sessions",
      reason: "unknown-provenance",
      eligible: false,
    });
  });

  it("treats a missing root with no missingSince stamp as not yet eligible", () => {
    // Written by a version that predates the stamp: start its clock rather
    // than deleting on first sight.
    const out = classifyTables(
      ["old_chunks"],
      { old: { root: "/gone", updatedAt: 1 } },
      { now: NOW, graceMs: GRACE, rootExists: () => false }
    );
    expect(out[0]).toMatchObject({ eligible: false });
  });

  it("skips non-chunk tables entirely", () => {
    expect(
      classifyTables(["something_else"], {}, {
        now: NOW,
        graceMs: GRACE,
        rootExists: () => false,
      })
    ).toEqual([]);
  });
});

describe("pruneOrphans", () => {
  function fakeStore(tables: string[]) {
    const dropped: string[] = [];
    return {
      dropped,
      listTables: async () => tables,
      deleteProject: async (p: string) => {
        dropped.push(p);
        return true;
      },
    };
  }

  const base = {
    now: NOW,
    graceMs: GRACE,
    rootExists: () => false,
  };

  it("deletes only eligible candidates and reports the rest", async () => {
    const store = fakeStore(["dead_chunks", "sessions_chunks", "fresh_chunks"]);
    const registry = {
      dead: { root: "/gone", updatedAt: 1, missingSince: NOW - GRACE - 1 },
      fresh: { root: "/gone2", updatedAt: 1, missingSince: NOW - 10 },
    };

    const report = await pruneOrphans(store as any, registry, base);

    expect(store.dropped).toEqual(["dead"]);
    expect(report.deleted.map((c) => c.project)).toEqual(["dead"]);
    // Reported for a human, never deleted on their behalf.
    expect(report.skipped.map((c) => c.project).sort()).toEqual([
      "fresh",
      "sessions",
    ]);
  });

  it("deletes nothing in dryRun but still reports what it would take", async () => {
    const store = fakeStore(["dead_chunks"]);
    const registry = {
      dead: { root: "/gone", updatedAt: 1, missingSince: NOW - GRACE - 1 },
    };

    const report = await pruneOrphans(store as any, registry, { ...base, dryRun: true });

    expect(store.dropped).toEqual([]);
    expect(report.deleted.map((c) => c.project)).toEqual(["dead"]);
  });

  it("with includeUnknown, still refuses anything the registry does not claim", async () => {
    // Even an explicit opt-in must not silently drop a live project's index;
    // unknown-provenance requires naming the project, not a blanket flag.
    const store = fakeStore(["sessions_chunks"]);

    const report = await pruneOrphans(store as any, {}, { ...base, includeUnknown: true });

    expect(store.dropped).toEqual([]);
    expect(report.skipped).toHaveLength(1);
  });

  it("keeps going when one deletion throws", async () => {
    const store = {
      listTables: async () => ["a_chunks", "b_chunks"],
      deleteProject: async (p: string) => {
        if (p === "a") throw new Error("locked");
        return true;
      },
    };
    const registry = {
      a: { root: "/gone", updatedAt: 1, missingSince: NOW - GRACE - 1 },
      b: { root: "/gone", updatedAt: 1, missingSince: NOW - GRACE - 1 },
    };

    const report = await pruneOrphans(store as any, registry, base);

    expect(report.deleted.map((c) => c.project)).toEqual(["b"]);
    expect(report.failed.map((c) => c.project)).toEqual(["a"]);
  });
});
