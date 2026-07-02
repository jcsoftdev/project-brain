import { describe, it, expect } from "bun:test";
import { handleAdr } from "../../src/tools/adr.js";

const mkDeps = () => {
  const stored: any[] = [];
  return {
    stored,
    deps: {
      embeddings: { dim: 4, model: "m", embed: async (t: string[]) => t.map(() => [1, 2, 3, 4]), isAvailable: async () => true },
      store: {
        ensureTable: async () => {}, buildIndexes: async () => {},
        upsert: async (_p: string, chunks: any[]) => { stored.push(...chunks); },
        getModuleChunks: async () => stored,
      },
    } as any,
  };
};

describe("manage_adr", () => {
  it("create renders canonical markdown and stores under adr/<slug>", async () => {
    const { deps, stored } = mkDeps();
    const r = await handleAdr({
      project: "p", action: "create", title: "Use RRF for hybrid search",
      context: "Two rankers disagree", decision: "Fuse with RRF", consequences: "Simpler tuning", status: "accepted",
    }, deps);
    expect((r.structuredContent as any).slug).toBe("use-rrf-for-hybrid-search");
    expect(stored[0].source).toBe("adr/use-rrf-for-hybrid-search");
    expect(stored[0].module).toBe("adr");
    expect(stored[0].content).toContain("## Decision");
    expect(stored[0].content).toContain("Status: accepted");
  });

  it("list returns summaries from the adr module", async () => {
    const { deps } = mkDeps();
    await handleAdr({ project: "p", action: "create", title: "T", context: "c", decision: "d", consequences: "q", status: "proposed" }, deps);
    const r = await handleAdr({ project: "p", action: "list" }, deps);
    expect((r.structuredContent as any).adrs.length).toBe(1);
    expect((r.structuredContent as any).adrs[0].slug).toBe("t");
  });

  it("create without required fields errors", async () => {
    const { deps } = mkDeps();
    const r = await handleAdr({ project: "p", action: "create", title: "X" } as any, deps);
    expect(r.isError).toBe(true);
  });
});
