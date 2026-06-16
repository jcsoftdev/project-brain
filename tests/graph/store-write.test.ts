// tests/graph/store-write.test.ts
import { test, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db";
import { GraphStore } from "../../src/graph/store";

test("replaceFile: first call inserts 1 edge", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);
  store.replaceFile("a.ts", "typescript", "h1", 1, [
    { name: "add", kind: "function", signature: "fn", start_line: 1, end_line: 3,
      edges: [{ dst_name: "log", edge_type: "call" }] },
  ]);
  const edges = db.query("SELECT count(*) c FROM edges").get() as { c: number };
  expect(edges.c).toBe(1);
  db.close();
});

test("replaceFile inserts symbols+edges and is idempotent", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);
  store.replaceFile("a.ts", "typescript", "h1", 1, [
    { name: "add", kind: "function", signature: "function add(a,b)", start_line: 1, end_line: 3,
      edges: [{ dst_name: "log", edge_type: "call" }] },
  ]);
  // re-run with same path → no duplicate rows
  store.replaceFile("a.ts", "typescript", "h2", 2, [
    { name: "add", kind: "function", signature: "function add(a,b)", start_line: 1, end_line: 3, edges: [] },
  ]);
  const syms = db.query("SELECT name FROM symbols").all() as { name: string }[];
  expect(syms).toEqual([{ name: "add" }]);
  const edges = db.query("SELECT count(*) c FROM edges").get() as { c: number };
  expect(edges.c).toBe(0); // second replace dropped the old edge
  db.close();
});
