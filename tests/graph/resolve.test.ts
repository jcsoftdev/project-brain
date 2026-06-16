import { test, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db";
import { GraphStore } from "../../src/graph/store";

test("resolveEdgesForFile links dst_symbol_id by name", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);
  store.replaceFile("b.ts", "typescript", "h", 1, [
    { name: "log", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [] },
  ]);
  store.replaceFile("a.ts", "typescript", "h", 1, [
    { name: "add", kind: "function", signature: "", start_line: 1, end_line: 3, edges: [{ dst_name: "log", edge_type: "call" }] },
  ]);
  store.resolveEdgesForFile("a.ts");
  const row = db.query("SELECT dst_symbol_id FROM edges WHERE dst_name='log'").get() as { dst_symbol_id: number | null };
  expect(row.dst_symbol_id).not.toBeNull();
  db.close();
});
