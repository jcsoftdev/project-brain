import { describe, it, expect } from "bun:test";
import { handleTracePath } from "../../src/tools/trace-path.js";
import type { ToolDeps } from "../../src/types.js";

describe("trace_path", () => {
  it("returns the path from a stub graph", async () => {
    const path = [
      { name: "a", kind: "function", signature: "", path: "a.ts", start_line: 1, end_line: 1 },
      { name: "b", kind: "function", signature: "", path: "b.ts", start_line: 2, end_line: 2 },
    ];
    const deps = {
      store: {} as ToolDeps["store"],
      embeddings: {} as ToolDeps["embeddings"],
      graph: { tracePath: (from: string, to: string, maxDepth?: number) => path } as any,
    } as ToolDeps;
    const r = await handleTracePath({ from: "a", to: "b" }, deps);
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as any).path).toEqual(path);
    expect((r.structuredContent as any).from).toBe("a");
    expect((r.structuredContent as any).to).toBe("b");
  });

  it("returns error content when graph dep is missing", async () => {
    const deps = {
      store: {} as ToolDeps["store"],
      embeddings: {} as ToolDeps["embeddings"],
    } as ToolDeps;
    const r = await handleTracePath({ from: "a", to: "b" }, deps);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).code).toBe("GRAPH_UNAVAILABLE");
  });
});
