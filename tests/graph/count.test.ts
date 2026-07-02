// tests/graph/count.test.ts
import { test, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db";
import { GraphStore } from "../../src/graph/store";

test("countSymbols returns 0 on an empty db", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);
  expect(store.countSymbols()).toBe(0);
  db.close();
});

test("countSymbols counts symbols seeded via replaceFile", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);
  store.replaceFile("a.ts", "typescript", "h1", 1, [
    { name: "add", kind: "function", signature: "fn add", start_line: 1, end_line: 3, edges: [] },
    { name: "sub", kind: "function", signature: "fn sub", start_line: 4, end_line: 6, edges: [] },
    { name: "mul", kind: "function", signature: "fn mul", start_line: 7, end_line: 9, edges: [] },
  ]);
  expect(store.countSymbols()).toBe(3);
  db.close();
});
