import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { handleFindCallers, handleFindCallees } from "../../src/tools/callgraph.js";
import type { ToolDeps } from "../../src/types.js";

/**
 * Seed a call chain: c calls b, b calls a.
 * resolveEdgesForFile is called after each file so edges link properly.
 */
function makeTestDeps(): { deps: ToolDeps; graph: GraphStore } {
  const db: Database = openGraphDb(":memory:");
  const graph = new GraphStore(db);

  graph.replaceFile("a.ts", "ts", "hash-a", Date.now(), [
    {
      name: "a",
      kind: "function",
      signature: "function a(): void",
      start_line: 1,
      end_line: 3,
      edges: [],
    },
  ]);
  graph.resolveEdgesForFile("a.ts");

  graph.replaceFile("b.ts", "ts", "hash-b", Date.now(), [
    {
      name: "b",
      kind: "function",
      signature: "function b(): void",
      start_line: 1,
      end_line: 3,
      edges: [{ dst_name: "a", edge_type: "calls" }],
    },
  ]);
  graph.resolveEdgesForFile("b.ts");

  graph.replaceFile("c.ts", "ts", "hash-c", Date.now(), [
    {
      name: "c",
      kind: "function",
      signature: "function c(): void",
      start_line: 1,
      end_line: 3,
      edges: [{ dst_name: "b", edge_type: "calls" }],
    },
  ]);
  graph.resolveEdgesForFile("c.ts");

  const deps: ToolDeps = {
    store: {} as ToolDeps["store"],
    embeddings: {} as ToolDeps["embeddings"],
    graph,
  };

  return { deps, graph };
}

describe("find_callers tool", () => {
  it("returns b as a caller of a", async () => {
    const { deps } = makeTestDeps();
    const result = await handleFindCallers({ name: "a" }, deps);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("b");
    expect(text).toContain("b.ts");
  });

  it("returns empty-result message for symbol with no callers", async () => {
    const { deps } = makeTestDeps();
    const result = await handleFindCallers({ name: "c" }, deps);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("c");
  });

  it("formats each hit as path:line kind name — signature", async () => {
    const { deps } = makeTestDeps();
    const result = await handleFindCallers({ name: "a" }, deps);
    const text = result.content[0].text;
    expect(text).toMatch(/b\.ts:\d+\s+function\s+b\s+—/);
  });

  it("returns error content when graph dep is missing", async () => {
    const deps: ToolDeps = {
      store: {} as ToolDeps["store"],
      embeddings: {} as ToolDeps["embeddings"],
    };
    const result = await handleFindCallers({ name: "a" }, deps);
    expect(result.isError).toBe(true);
  });
});

describe("find_callees tool", () => {
  it("returns b as a callee of c", async () => {
    const { deps } = makeTestDeps();
    const result = await handleFindCallees({ name: "c" }, deps);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("b");
    expect(text).toContain("b.ts");
  });

  it("returns empty-result message for symbol with no callees", async () => {
    const { deps } = makeTestDeps();
    const result = await handleFindCallees({ name: "a" }, deps);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("a");
  });

  it("formats each hit as path:line kind name — signature", async () => {
    const { deps } = makeTestDeps();
    const result = await handleFindCallees({ name: "c" }, deps);
    const text = result.content[0].text;
    expect(text).toMatch(/b\.ts:\d+\s+function\s+b\s+—/);
  });

  it("returns error content when graph dep is missing", async () => {
    const deps: ToolDeps = {
      store: {} as ToolDeps["store"],
      embeddings: {} as ToolDeps["embeddings"],
    };
    const result = await handleFindCallees({ name: "c" }, deps);
    expect(result.isError).toBe(true);
  });
});
