// tests/graph/list-files.test.ts
import { test, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db";
import { GraphStore } from "../../src/graph/store";

test("listFiles returns [] on an empty db", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);
  expect(store.listFiles()).toEqual([]);
  db.close();
});

test("listFiles returns every file path the graph holds", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);
  store.replaceFile("src/a.ts", "typescript", "h1", 1, [
    { name: "add", kind: "function", signature: "fn add", start_line: 1, end_line: 3, edges: [] },
  ]);
  store.replaceFile("node_modules/zod/index.js", "javascript", "h2", 1, [
    { name: "parse", kind: "function", signature: "fn parse", start_line: 1, end_line: 2, edges: [] },
  ]);

  expect(store.listFiles().sort()).toEqual(["node_modules/zod/index.js", "src/a.ts"]);
  db.close();
});

test("listFiles drops a path after deleteFile", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);
  store.replaceFile("src/a.ts", "typescript", "h1", 1, [
    { name: "add", kind: "function", signature: "fn add", start_line: 1, end_line: 3, edges: [] },
  ]);
  store.deleteFile("src/a.ts");

  expect(store.listFiles()).toEqual([]);
  db.close();
});
