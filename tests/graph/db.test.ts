import { test, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db";

test("openGraphDb applies schema and WAL", () => {
  const db = openGraphDb(":memory:");
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  expect(tables.map(t => t.name)).toEqual(["edges", "files", "symbols"]);
  const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  expect(mode.journal_mode).toBe("memory");
  db.close();
});
