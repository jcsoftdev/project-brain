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

test("rank mass is conserved (sums to 1) for unfocused and focused runs", () => {
  const db = openGraphDb(":memory:"); const store = new GraphStore(db);
  // seedFocus has two dangling sinks (onlyFromTarget, shared) — mass
  // conservation here also guards the dangling-mass redistribution path.
  seedFocus(store);
  const unfocusedSum = store.pageRank().reduce((s, r) => s + r.rank, 0);
  const focusedSum = store.pageRank({ focus: ["target"] }).reduce((s, r) => s + r.rank, 0);
  expect(Math.abs(unfocusedSum - 1.0)).toBeLessThan(1e-6);
  expect(Math.abs(focusedSum - 1.0)).toBeLessThan(1e-6);
  db.close();
});

test("dangling mass is routed through the personalization vector, not uniformly", () => {
  const db = openGraphDb(":memory:"); const store = new GraphStore(db);
  seedFocus(store);
  // Under focus on "target": "other" has no inbound edges AND zero teleport
  // mass. With personalization-routed dangling mass (textbook personalized
  // PageRank), the sinks' mass teleports back to "target" only, so "other"
  // receives exactly 0. If dangling mass were instead redistributed
  // UNIFORMLY across all nodes, "other" would get damping * danglingMass / n
  // per iteration — a measurably positive rank. This pins the correct choice.
  const focused = store.pageRank({ focus: ["target"] });
  const other = focused.find((r) => r.name === "other")!;
  expect(other.rank).toBeGreaterThanOrEqual(0);
  expect(other.rank).toBeLessThan(1e-12);
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
