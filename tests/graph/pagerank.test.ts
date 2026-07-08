import { test, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db";
import { GraphStore } from "../../src/graph/store";

function seedHub(store: GraphStore) {
  // util is called by a, b, c but calls nothing itself (a hub with many inbound edges).
  // isolated has no edges in or out at all.
  store.replaceFile("f.ts", "typescript", "h", 1, [
    { name: "a", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [{ dst_name: "util", edge_type: "call" }] },
    { name: "b", kind: "function", signature: "", start_line: 2, end_line: 2, edges: [{ dst_name: "util", edge_type: "call" }] },
    { name: "c", kind: "function", signature: "", start_line: 3, end_line: 3, edges: [{ dst_name: "util", edge_type: "call" }] },
    { name: "util", kind: "function", signature: "", start_line: 4, end_line: 4, edges: [] },
    { name: "isolated", kind: "function", signature: "", start_line: 5, end_line: 5, edges: [] },
  ]);
  store.resolveEdgesForFile("f.ts");
}

function seedFocus(store: GraphStore) {
  // target -> onlyFromTarget (target is the sole caller of onlyFromTarget).
  // other -> shared, target -> shared (shared has two callers, one of which is target).
  store.replaceFile("f.ts", "typescript", "h", 1, [
    { name: "target", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [{ dst_name: "onlyFromTarget", edge_type: "call" }, { dst_name: "shared", edge_type: "call" }] },
    { name: "other", kind: "function", signature: "", start_line: 2, end_line: 2, edges: [{ dst_name: "shared", edge_type: "call" }] },
    { name: "onlyFromTarget", kind: "function", signature: "", start_line: 3, end_line: 3, edges: [] },
    { name: "shared", kind: "function", signature: "", start_line: 4, end_line: 4, edges: [] },
  ]);
  store.resolveEdgesForFile("f.ts");
}

test("a hub symbol (many callers) ranks higher than an isolated symbol", () => {
  const db = openGraphDb(":memory:"); const store = new GraphStore(db);
  seedHub(store);
  const ranked = store.pageRank();
  const util = ranked.find((r) => r.name === "util")!;
  const isolated = ranked.find((r) => r.name === "isolated")!;
  expect(util.rank).toBeGreaterThan(isolated.rank);
  expect(ranked.indexOf(util)).toBeLessThan(ranked.indexOf(isolated));
  db.close();
});

test("dangling nodes (sinks) don't crash and produce finite positive ranks", () => {
  const db = openGraphDb(":memory:"); const store = new GraphStore(db);
  seedHub(store); // util and isolated are both sinks (no outgoing edges)
  const ranked = store.pageRank();
  expect(ranked.length).toBe(5);
  for (const r of ranked) {
    expect(Number.isFinite(r.rank)).toBe(true);
    expect(r.rank).toBeGreaterThan(0);
  }
  db.close();
});

test("focus option concentrates rank on symbols reachable from the focus target", () => {
  const db = openGraphDb(":memory:"); const store = new GraphStore(db);
  seedFocus(store);
  const unfocused = store.pageRank();
  const focused = store.pageRank({ focus: ["target"] });

  // shared has two callers (target AND other), onlyFromTarget has just one
  // (target). Unfocused, shared outranks onlyFromTarget because it gets
  // support from two sources. Focusing the teleport vector on target should
  // shrink (or close) that gap, since onlyFromTarget is reachable ONLY
  // through the focus target while shared's "other" contributor is
  // teleport-starved under focus.
  const unfocusedRatio =
    unfocused.find((r) => r.name === "onlyFromTarget")!.rank /
    unfocused.find((r) => r.name === "shared")!.rank;
  const focusedRatio =
    focused.find((r) => r.name === "onlyFromTarget")!.rank /
    focused.find((r) => r.name === "shared")!.rank;
  expect(focusedRatio).toBeGreaterThan(unfocusedRatio);
  db.close();
});

test("focus with no matching name falls back to unfocused behavior without throwing", () => {
  const db = openGraphDb(":memory:"); const store = new GraphStore(db);
  seedFocus(store);
  expect(() => store.pageRank({ focus: ["doesNotExist"] })).not.toThrow();
  const ranked = store.pageRank({ focus: ["doesNotExist"] });
  expect(ranked.length).toBe(4);
  for (const r of ranked) expect(Number.isFinite(r.rank)).toBe(true);
  db.close();
});

test("empty graph returns []", () => {
  const db = openGraphDb(":memory:"); const store = new GraphStore(db);
  expect(store.pageRank()).toEqual([]);
  db.close();
});

test("results are sorted descending by rank", () => {
  const db = openGraphDb(":memory:"); const store = new GraphStore(db);
  seedHub(store);
  const ranked = store.pageRank();
  for (let i = 0; i < ranked.length - 1; i++) {
    expect(ranked[i].rank).toBeGreaterThanOrEqual(ranked[i + 1].rank);
  }
  db.close();
});
