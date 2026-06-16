import { test, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db";

test("openGraphDb applies schema and WAL", () => {
  const db = openGraphDb(":memory:");
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  expect(tables.map(t => t.name)).toEqual(["edges", "files", "symbols"]);
  db.close();
});
