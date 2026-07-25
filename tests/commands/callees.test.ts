import { describe, it, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { runCallees } from "../../src/commands/callees.js";

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

describe("runCallees", () => {
  it("returns formatted callee text for a symbol with callees", async () => {
    const graph = makeGraph();
    const text = await runCallees("b", graph);
    expect(text).toContain("a.ts:1");
    expect(text).toContain("a");
    graph.close();
  });

  it("returns a no-callees message for a symbol with none", async () => {
    const graph = makeGraph();
    const text = await runCallees("a", graph);
    expect(text).toContain("a");
    expect(text.toLowerCase()).toContain("no callees");
    graph.close();
  });

  it("exports execute", async () => {
    const mod = await import("../../src/commands/callees.js");
    expect(typeof mod.execute).toBe("function");
  });
});
