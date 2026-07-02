import { test, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db";
import { GraphStore } from "../../src/graph/store";

function seed(store: GraphStore) {
  // a → b → c, plus a → x (dead end), and a cycle c → a
  store.replaceFile("f.ts", "typescript", "h", 1, [
    { name: "a", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [{ dst_name: "b", edge_type: "call" }, { dst_name: "x", edge_type: "call" }] },
    { name: "b", kind: "function", signature: "", start_line: 2, end_line: 2, edges: [{ dst_name: "c", edge_type: "call" }] },
    { name: "c", kind: "function", signature: "", start_line: 3, end_line: 3, edges: [{ dst_name: "a", edge_type: "call" }] },
    { name: "x", kind: "function", signature: "", start_line: 4, end_line: 4, edges: [] },
  ]);
  store.resolveEdgesForFile("f.ts");
}

test("finds the shortest caller→callee path a→b→c", () => {
  const db = openGraphDb(":memory:"); const store = new GraphStore(db);
  seed(store);
  const path = store.tracePath("a", "c");
  expect(path.map((h) => h.name)).toEqual(["a", "b", "c"]);
  db.close();
});

test("returns [] when unreachable and survives cycles", () => {
  const db = openGraphDb(":memory:"); const store = new GraphStore(db);
  seed(store);
  expect(store.tracePath("x", "a")).toEqual([]); // x calls nothing
  expect(store.tracePath("a", "a").map((h) => h.name)).toEqual(["a"]); // trivial
  db.close();
});

test("respects maxDepth", () => {
  const db = openGraphDb(":memory:"); const store = new GraphStore(db);
  seed(store);
  expect(store.tracePath("a", "c", 1)).toEqual([]); // needs depth 2
  db.close();
});
