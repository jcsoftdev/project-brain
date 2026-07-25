import { describe, it, expect } from "bun:test";
import type { GraphStore } from "../../src/graph/store.js";
import { runMap } from "../../src/commands/map.js";

const RANKED = [
  { id: 1, name: "createServer", kind: "function", signature: "(opts) => Server", file: "src/server.ts", start_line: 10, end_line: 40, rank: 0.9 },
  { id: 2, name: "registerSearch", kind: "function", signature: "(server, deps) => void", file: "src/server.ts", start_line: 50, end_line: 60, rank: 0.7 },
];

function stubGraph(ranked: typeof RANKED, focusReceiver?: (opts: any) => void): GraphStore {
  return {
    pageRank: (opts?: any) => {
      focusReceiver?.(opts);
      return ranked;
    },
  } as unknown as GraphStore;
}

describe("runMap", () => {
  it("renders the map text plus a files/symbols footer", async () => {
    const graph = stubGraph(RANKED);
    const text = await runMap(undefined, undefined, graph);
    expect(text).toContain("src/server.ts");
    expect(text).toContain("createServer");
    expect(text).toContain("— 1 files, 2 symbols");
  });

  it("adds a truncation note when the map was truncated", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      name: `someVeryDescriptiveFunctionName${i}`,
      kind: "function",
      signature: `(argumentOne: string, argumentTwo: number, argumentThree: boolean) => Promise<SomeLongResultType${i}>`,
      file: `src/module${i % 4}/file${i}.ts`,
      start_line: 1,
      end_line: 10,
      rank: 1 - i * 0.01,
    }));
    const graph = stubGraph(many);
    const text = await runMap(100, undefined, graph);
    expect(text.toLowerCase()).toContain("truncated");
  });

  it("passes the focus list through to graph.pageRank", async () => {
    let received: any = null;
    const graph = stubGraph(RANKED, (opts) => { received = opts; });
    await runMap(undefined, ["createServer"], graph);
    expect(received).toEqual({ focus: ["createServer"] });
  });

  it("exports execute", async () => {
    const mod = await import("../../src/commands/map.js");
    expect(typeof mod.execute).toBe("function");
  });
});
