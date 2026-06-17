import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { handleImpact } from "../../src/tools/impact.js";
import type { ToolDeps } from "../../src/types.js";

/**
 * Seed a call chain: c→b→a (c calls b, b calls a).
 * impact("a") should return transitive callers: b and c.
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

describe("impact tool", () => {
  it("returns transitive callers b and c for symbol a", async () => {
    const { deps } = makeTestDeps();
    const result = await handleImpact({ name: "a" }, deps);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("b");
    expect(text).toContain("b.ts");
    expect(text).toContain("c");
    expect(text).toContain("c.ts");
  });

  it("returns empty-result message for symbol with no callers", async () => {
    const { deps } = makeTestDeps();
    const result = await handleImpact({ name: "c" }, deps);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("c");
  });

  it("formats each hit as path:line kind name — signature", async () => {
    const { deps } = makeTestDeps();
    const result = await handleImpact({ name: "a" }, deps);
    const text = result.content[0].text;
    expect(text).toMatch(/b\.ts:\d+\s+function\s+b\s+—/);
    expect(text).toMatch(/c\.ts:\d+\s+function\s+c\s+—/);
  });

  it("returns error content when graph dep is missing", async () => {
    const deps: ToolDeps = {
      store: {} as ToolDeps["store"],
      embeddings: {} as ToolDeps["embeddings"],
    };
    const result = await handleImpact({ name: "a" }, deps);
    expect(result.isError).toBe(true);
  });

  it("respects maxDepth — depth 1 returns only direct callers (b), not transitive (c)", async () => {
    const { deps } = makeTestDeps();
    const result = await handleImpact({ name: "a", maxDepth: 1 }, deps);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("b.ts");
    expect(text).not.toContain("c.ts");
  });
});
