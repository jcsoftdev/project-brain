import { test, expect, spyOn } from "bun:test";
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

test("resolveEdgesForFile prefers a same-file symbol over a same-named symbol in another file", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);

  // fileB defines an UNRELATED `handler`, inserted FIRST so its row has the
  // lowest rowid — the exact condition that made the old arbitrary
  // "LIMIT 1, no scoping" match pick the wrong file.
  store.replaceFile("fileB.ts", "typescript", "h", 1, [
    { name: "handler", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [] },
  ]);
  // fileA defines its OWN `handler` AND a `caller` that calls it locally.
  store.replaceFile("fileA.ts", "typescript", "h", 1, [
    { name: "handler", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [] },
    { name: "caller", kind: "function", signature: "", start_line: 3, end_line: 5, edges: [{ dst_name: "handler", edge_type: "call" }] },
  ]);
  store.resolveEdgesForFile("fileB.ts");
  store.resolveEdgesForFile("fileA.ts");

  const fileAHandlerId = (db.query(
    "SELECT s.id FROM symbols s JOIN files f ON s.file_id=f.id WHERE f.path='fileA.ts' AND s.name='handler'"
  ).get() as { id: number }).id;

  const edge = db.query(
    "SELECT dst_symbol_id FROM edges WHERE dst_name='handler'"
  ).get() as { dst_symbol_id: number | null };

  // The caller→handler edge must resolve to fileA's OWN handler, not fileB's.
  expect(edge.dst_symbol_id).toBe(fileAHandlerId);

  db.close();
});

test("resolveEdgesForFile still falls back to the arbitrary match when no same-file candidate exists", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);

  // No same-file `log` exists anywhere in a.ts — must still resolve via the
  // pre-existing global fallback, exactly like before this change.
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

test("resolveEdgesForFiles resolves edges for multiple files in a single batch call", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);

  store.replaceFile("b.ts", "typescript", "h", 1, [
    { name: "log", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [] },
  ]);
  store.replaceFile("a.ts", "typescript", "h", 1, [
    { name: "add", kind: "function", signature: "", start_line: 1, end_line: 3, edges: [{ dst_name: "log", edge_type: "call" }] },
  ]);
  store.replaceFile("c.ts", "typescript", "h", 1, [
    { name: "mul", kind: "function", signature: "", start_line: 1, end_line: 3, edges: [{ dst_name: "log", edge_type: "call" }] },
  ]);

  // Single batch call resolving edges for BOTH a.ts and c.ts at once.
  store.resolveEdgesForFiles(["a.ts", "c.ts"]);

  const rows = db.query(
    "SELECT dst_name, dst_symbol_id FROM edges WHERE dst_name='log' ORDER BY src_symbol_id"
  ).all() as { dst_name: string; dst_symbol_id: number | null }[];

  expect(rows.length).toBe(2);
  for (const row of rows) {
    expect(row.dst_symbol_id).not.toBeNull();
  }

  db.close();
});

test("resolveEdgesForFiles wraps all files in a single transaction (all-or-nothing)", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);

  store.replaceFile("b.ts", "typescript", "h", 1, [
    { name: "log", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [] },
  ]);
  store.replaceFile("a.ts", "typescript", "h", 1, [
    { name: "add", kind: "function", signature: "", start_line: 1, end_line: 3, edges: [{ dst_name: "log", edge_type: "call" }] },
  ]);

  // db.transaction() wraps the whole batch — spy on the underlying db's
  // transaction factory to confirm it is invoked exactly once for the batch
  // call (not once per file), mirroring replaceFile's existing pattern.
  const txSpy = spyOn(db, "transaction");
  store.resolveEdgesForFiles(["a.ts"]);
  expect(txSpy.mock.calls.length).toBe(1);
  txSpy.mockRestore();

  db.close();
});
