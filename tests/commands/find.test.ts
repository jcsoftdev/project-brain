import { describe, it, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { runFind } from "../../src/commands/find.js";

function makeGraph(): GraphStore {
  const graph = new GraphStore(openGraphDb(":memory:"));
  graph.replaceFile("a.ts", "ts", "hash", Date.now(), [
    { name: "add", kind: "function", signature: "function add(a: number, b: number): number", start_line: 1, end_line: 3, edges: [] },
  ]);
  return graph;
}

describe("runFind", () => {
  it("returns formatted hit text for a known symbol", async () => {
    const graph = makeGraph();
    const text = await runFind("add", graph);
    expect(text).toContain("a.ts:1");
    expect(text).toContain("add");
    graph.close();
  });

  it("returns a not-found message for an unknown symbol", async () => {
    const graph = makeGraph();
    const text = await runFind("doesNotExist", graph);
    expect(text).toContain("doesNotExist");
    expect(text.toLowerCase()).toContain("no symbol");
    graph.close();
  });

  it("exports execute", async () => {
    const mod = await import("../../src/commands/find.js");
    expect(typeof mod.execute).toBe("function");
  });
});
