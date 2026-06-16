import { test, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db";
import { GraphStore } from "../../src/graph/store";

function seed(store: GraphStore) {
  // c calls b, b calls a  => impact(a) = {b, c}
  store.replaceFile("a.ts", "ts", "h", 1, [{ name: "a", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [] }]);
  store.replaceFile("b.ts", "ts", "h", 1, [{ name: "b", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [{ dst_name: "a", edge_type: "call" }] }]);
  store.replaceFile("c.ts", "ts", "h", 1, [{ name: "c", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [{ dst_name: "b", edge_type: "call" }] }]);
  store.resolveEdgesForFile("b.ts");
  store.resolveEdgesForFile("c.ts");
}

test("findSymbol / callers / callees / impact", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db); seed(store);
  expect(store.findSymbol("a").map(s => s.name)).toEqual(["a"]);
  expect(store.findCallers("a").map(s => s.name)).toEqual(["b"]);
  expect(store.findCallees("b").map(s => s.name)).toEqual(["a"]);
  expect(store.impact("a").map(s => s.name).sort()).toEqual(["b", "c"]);
  db.close();
});

test("impact terminates on a cycle", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);
  store.replaceFile("x.ts", "ts", "h", 1, [{ name: "x", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [{ dst_name: "y", edge_type: "call" }] }]);
  store.replaceFile("y.ts", "ts", "h", 1, [{ name: "y", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [{ dst_name: "x", edge_type: "call" }] }]);
  store.resolveEdgesForFile("x.ts"); store.resolveEdgesForFile("y.ts");
  expect(store.impact("x").map(s => s.name).sort()).toEqual(["x", "y"]); // UNION dedups, no infinite loop
  db.close();
});
