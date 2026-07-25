import { describe, it, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { runImpact } from "../../src/commands/impact.js";

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
  graph.replaceFile("c.ts", "ts", "hash-c", Date.now(), [
    { name: "c", kind: "function", signature: "function c(): void", start_line: 1, end_line: 3, edges: [{ dst_name: "b", edge_type: "calls" }] },
  ]);
  graph.resolveEdgesForFile("c.ts");
  return graph;
}

describe("runImpact", () => {
  it("returns transitive callers b and c for symbol a with default maxDepth", async () => {
    const graph = makeGraph();
    const text = await runImpact("a", undefined, graph);
    expect(text).toContain("b.ts");
    expect(text).toContain("c.ts");
    graph.close();
  });

  it("respects an explicit maxDepth of 1 — only direct caller b, not transitive c", async () => {
    const graph = makeGraph();
    const text = await runImpact("a", 1, graph);
    expect(text).toContain("b.ts");
    expect(text).not.toContain("c.ts");
    graph.close();
  });

  it("returns a no-callers message for a symbol with no transitive callers", async () => {
    const graph = makeGraph();
    const text = await runImpact("c", undefined, graph);
    expect(text).toContain("c");
    expect(text.toLowerCase()).toContain("no transitive callers");
    graph.close();
  });

  it("exports execute", async () => {
    const mod = await import("../../src/commands/impact.js");
    expect(typeof mod.execute).toBe("function");
  });
});
