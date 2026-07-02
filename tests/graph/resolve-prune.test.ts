import { test, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db";
import { GraphStore } from "../../src/graph/store";

// Chain: c (c.ts) → b (b.ts) → a (a.ts).
// impact(a) must surface b and c via the reverse call graph (dst_symbol_id walk).
// When the middle file b.ts is deleted, the c→b edge's dst_symbol_id becomes
// stale. SQLite reuses rowids, so without pruneDanglingEdges that stale id can
// point at a reused (wrong) symbol and impact would traverse it incorrectly.
function seedChain(store: GraphStore) {
  store.replaceFile("a.ts", "typescript", "h", 1, [
    { name: "a", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [] },
  ]);
  store.replaceFile("b.ts", "typescript", "h", 1, [
    { name: "b", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [{ dst_name: "a", edge_type: "call" }] },
  ]);
  store.replaceFile("c.ts", "typescript", "h", 1, [
    { name: "c", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [{ dst_name: "b", edge_type: "call" }] },
  ]);
  store.resolveEdgesForFile("a.ts");
  store.resolveEdgesForFile("b.ts");
  store.resolveEdgesForFile("c.ts");
}

test("impact walks the full reverse chain c→b→a", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);
  seedChain(store);

  const hits = store.impact("a").map((h) => h.name);
  expect(hits).toContain("b");
  expect(hits).toContain("c");
  db.close();
});

test("pruneDanglingEdges NULLs the stale edge after the middle file is deleted", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);
  seedChain(store);

  // Sanity: c→b edge is resolved before deletion.
  const before = db
    .query("SELECT dst_symbol_id FROM edges WHERE dst_name='b'")
    .get() as { dst_symbol_id: number | null };
  expect(before.dst_symbol_id).not.toBeNull();

  // Delete the middle file → symbol b and its outgoing edge (b→a) are removed
  // via ON DELETE CASCADE. The c→b edge survives with a now-stale dst_symbol_id.
  store.deleteFile("b.ts");
  store.pruneDanglingEdges();

  // b is gone entirely.
  expect(store.findSymbol("b").length).toBe(0);

  // The surviving c→b edge must NOT point at a live (reused) rowid.
  const after = db
    .query("SELECT dst_symbol_id FROM edges WHERE dst_name='b'")
    .get() as { dst_symbol_id: number | null };
  expect(after.dst_symbol_id).toBeNull();

  // impact(a) must no longer surface b (deleted) and must not produce a stale
  // hit for the dangling edge. c is no longer transitively connected to a.
  const hits = store.impact("a").map((h) => h.name);
  expect(hits).not.toContain("b");

  db.close();
});

test("pruneDanglingEdges fixes a stale edge after RENAME-as-replace (no file deleted)", () => {
  // The dangerous case the `deleted>0`-only gate missed: a file is EDITED (not
  // deleted) so a symbol it defined disappears, but edges in OTHER files still
  // point at the now-freed rowid — which SQLite can reassign to a new symbol.
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);

  // caller.ts calls `target`; target.ts defines `target`.
  store.replaceFile("target.ts", "typescript", "h", 1, [
    { name: "target", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [] },
  ]);
  store.replaceFile("caller.ts", "typescript", "h", 1, [
    { name: "caller", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [{ dst_name: "target", edge_type: "call" }] },
  ]);
  store.resolveEdgesForFile("caller.ts");

  const linked = db
    .query("SELECT dst_symbol_id FROM edges WHERE dst_name='target'")
    .get() as { dst_symbol_id: number | null };
  expect(linked.dst_symbol_id).not.toBeNull();

  // Edit target.ts: `target` is gone, replaced by `renamed`. replaceFile deletes
  // the old rows (freeing target's rowid) and inserts the new symbol — which may
  // claim the same rowid. The caller.ts edge is NOT in this run's touched set,
  // so resolveEdgesForFile never revisits it; only the prune pass can fix it.
  store.replaceFile("target.ts", "typescript", "h2", 2, [
    { name: "renamed", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [] },
  ]);
  store.pruneDanglingEdges();

  const after = db
    .query("SELECT dst_symbol_id FROM edges WHERE dst_name='target'")
    .get() as { dst_symbol_id: number | null };
  // The edge must NOT silently point at `renamed` even if it reused target's rowid.
  expect(after.dst_symbol_id).toBeNull();
  // findCallers of the renamed symbol must not surface `caller` via the stale edge
  // (whether or not SQLite reused target's freed rowid for `renamed`).
  expect(store.findCallers("renamed").map((h) => h.name)).not.toContain("caller");

  db.close();
});

test("pruneDanglingEdges re-links to a same-file symbol in preference to an arbitrary match", () => {
  const db = openGraphDb(":memory:");
  const store = new GraphStore(db);

  // fileB has an unrelated `handler`, inserted first (lowest rowid).
  store.replaceFile("fileB.ts", "typescript", "h", 1, [
    { name: "handler", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [] },
  ]);
  // fileA has its own `handler` and a `caller` that calls it locally.
  store.replaceFile("fileA.ts", "typescript", "h", 1, [
    { name: "handler", kind: "function", signature: "", start_line: 1, end_line: 1, edges: [] },
    { name: "caller", kind: "function", signature: "", start_line: 3, end_line: 5, edges: [{ dst_name: "handler", edge_type: "call" }] },
  ]);

  // Force the edge into a dangling state (dst_symbol_id NULL) the way prune
  // encounters it in practice, then let pruneDanglingEdges re-link it.
  db.query("UPDATE edges SET dst_symbol_id = NULL WHERE dst_name = 'handler'").run();
  store.pruneDanglingEdges();

  const fileAHandlerId = (db.query(
    "SELECT s.id FROM symbols s JOIN files f ON s.file_id=f.id WHERE f.path='fileA.ts' AND s.name='handler'"
  ).get() as { id: number }).id;

  const edge = db.query("SELECT dst_symbol_id FROM edges WHERE dst_name='handler'").get() as { dst_symbol_id: number | null };
  expect(edge.dst_symbol_id).toBe(fileAHandlerId);

  db.close();
});
