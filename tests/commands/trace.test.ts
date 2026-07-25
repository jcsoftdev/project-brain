import { describe, it, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { runTrace } from "../../src/commands/trace.js";

function makeGraph(): GraphStore {
  const graph = new GraphStore(openGraphDb(":memory:"));
  graph.replaceFile("a.ts", "ts", "hash-a", Date.now(), [
    { name: "a", kind: "function", signature: "function a(): void", start_line: 1, end_line: 3, edges: [] },
  ]);
  graph.resolveEdgesForFile("a.ts");
  graph.replaceFile("b.ts", "ts", "hash-b", Date.now(), [
    { name: "b", kind: "function", signature: "function b(): void", start_line: 5, end_line: 7, edges: [{ dst_name: "a", edge_type: "calls" }] },
  ]);
  graph.resolveEdgesForFile("b.ts");
  graph.replaceFile("c.ts", "ts", "hash-c", Date.now(), [
    { name: "c", kind: "function", signature: "function c(): void", start_line: 9, end_line: 11, edges: [{ dst_name: "b", edge_type: "calls" }] },
  ]);
  graph.resolveEdgesForFile("c.ts");
  return graph;
}

describe("runTrace", () => {
  it("renders the chain as path:line name() joined by arrows", async () => {
    const graph = makeGraph();
    const text = await runTrace("c", "a", undefined, graph);
    expect(text).toBe("c.ts:9 c() → b.ts:5 b() → a.ts:1 a()");
    graph.close();
  });

  it("prints a not-an-error message when no path exists (exit-code-neutral text)", async () => {
    const graph = makeGraph();
    const text = await runTrace("a", "c", undefined, graph);
    expect(text).toBe("No path found from a to c (within depth 8).");
    graph.close();
  });

  it("uses a custom maxDepth in the no-path message", async () => {
    const graph = makeGraph();
    const text = await runTrace("a", "c", 2, graph);
    expect(text).toContain("within depth 2");
    graph.close();
  });

  it("exports execute", async () => {
    const mod = await import("../../src/commands/trace.js");
    expect(typeof mod.execute).toBe("function");
  });
});
