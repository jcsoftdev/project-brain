import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { handleFindSymbol } from "../../src/tools/find-symbol.js";
import type { ToolDeps } from "../../src/types.js";

function makeTestDeps(): { deps: ToolDeps; graph: GraphStore } {
  const db: Database = openGraphDb(":memory:");
  const graph = new GraphStore(db);

  graph.replaceFile("a.ts", "ts", "abc123", Date.now(), [
    {
      name: "add",
      kind: "function",
      signature: "function add(a: number, b: number): number",
      start_line: 1,
      end_line: 3,
      edges: [],
    },
  ]);

  const deps = {
    store: {} as ToolDeps["store"],
    embeddings: {} as ToolDeps["embeddings"],
    graph,
  };

  return { deps, graph };
}

describe("find_symbol tool", () => {
  it("returns a hit for a known symbol", async () => {
    const { deps } = makeTestDeps();
    const result = await handleFindSymbol({ name: "add" }, deps);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("add");
    expect(text).toContain("a.ts");
    expect(text).toContain("1");
  });

  it("returns an empty-result message for unknown symbol", async () => {
    const { deps } = makeTestDeps();
    const result = await handleFindSymbol({ name: "nonExistent" }, deps);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("nonExistent");
  });

  it("formats each hit as path:line kind name — signature", async () => {
    const { deps } = makeTestDeps();
    const result = await handleFindSymbol({ name: "add" }, deps);
    const text = result.content[0].text;
    // Expect the "path:start_line  kind name — signature" format
    expect(text).toMatch(/a\.ts:\d+\s+function\s+add\s+—/);
  });

  it("returns error content when graph dep is missing", async () => {
    const deps: ToolDeps = {
      store: {} as ToolDeps["store"],
      embeddings: {} as ToolDeps["embeddings"],
    };
    const result = await handleFindSymbol({ name: "add" }, deps);
    expect(result.isError).toBe(true);
  });
});
