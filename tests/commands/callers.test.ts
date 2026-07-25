import { describe, it, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { runCallers } from "../../src/commands/callers.js";

function makeGraph(): GraphStore {
  const graph = new GraphStore(openGraphDb(":memory:"));
  graph.replaceFile("a.ts", "ts", "hash-a", Date.now(), [
    { name: "a", kind: "function", signature: "function a(): void", start_line: 1, end_line: 3, edges: [] },
  ]);
  graph.resolveEdgesForFile("a.ts");
  graph.replaceFile("b.ts", "ts", "hash-b", Date.now(), [
    { name: "b", kind: "function", signature: "function b(): void", start_line: 1, end_line: 3, edges: [{ dst_name: "a", edge_type: "calls" }] },
  ]);
  graph.resolveEdgesForFile("b.ts");
  return graph;
}

describe("runCallers", () => {
  it("returns formatted caller text for a symbol with callers", async () => {
    const graph = makeGraph();
    const text = await runCallers("a", graph);
    expect(text).toContain("b.ts:1");
    expect(text).toContain("b");
    graph.close();
  });

  it("returns a no-callers message for a symbol with none", async () => {
    const graph = makeGraph();
    const text = await runCallers("b", graph);
    expect(text).toContain("b");
    expect(text.toLowerCase()).toContain("no callers");
    graph.close();
  });

  it("exports execute", async () => {
    const mod = await import("../../src/commands/callers.js");
    expect(typeof mod.execute).toBe("function");
  });
});
