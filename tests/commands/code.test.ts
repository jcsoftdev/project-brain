import { describe, it, expect } from "bun:test";
import type { VectorStore, SearchResult } from "../../src/types.js";
import { runCode, runCodeCommand } from "../../src/commands/code.js";

function makeStore(overrides: Partial<VectorStore> = {}): VectorStore {
  return {
    ensureTable: async () => {},
    upsert: async () => {},
    batchReplace: async () => {},
    search: async () => [],
    deleteBySource: async () => {},
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async () => 0,
    optimize: async () => {},
    buildIndexes: async () => {},
    hybridSearch: async () => [],
    getChunkById: async () => null,
    assertDim: async () => {},
    ...overrides,
  };
}

const HIT: SearchResult = {
  id: "a::0",
  content: "function chargeCard(amount: number) {\n  return gateway.charge(amount);\n}",
  source: "src/billing.ts",
  module: "src",
  score: 0.87,
  symbol_name: "chargeCard",
  start_line: 10,
  end_line: 13,
};

describe("runCode", () => {
  it("renders a compact block with header, score, and snippet lines for hits", async () => {
    const store = makeStore({ ftsSearch: async () => [HIT] });
    const text = await runCode("chargeCard", 10, "demo", store);
    expect(text).toContain("chargeCard");
    expect(text).toContain("src/billing.ts");
    expect(text).toContain("L10-13");
    expect(text).toContain("0.87");
    expect(text).toContain("gateway.charge");
  });

  it("returns a no-matches message for an empty result set (not an error)", async () => {
    const store = makeStore({ ftsSearch: async () => [] });
    const text = await runCode("nonexistentTerm", 10, "demo", store);
    expect(text.toLowerCase()).toContain("no matches");
    expect(text).toContain("nonexistentTerm");
  });

  it("exports execute", async () => {
    const mod = await import("../../src/commands/code.js");
    expect(typeof mod.execute).toBe("function");
  });
});

describe("runCodeCommand", () => {
  it("prints an actionable hint and exits 1 when the project has zero indexed chunks, without calling ftsSearch", async () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];
    const logs: string[] = [];
    let ftsCalled = false;

    const store = makeStore({
      countChunks: async () => 0,
      ftsSearch: async () => { ftsCalled = true; return []; },
    });

    await runCodeCommand("chargeCard", 10, "demo", store, {
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
      exit: (c) => exitCodes.push(c),
    });

    expect(ftsCalled).toBe(false);
    expect(exitCodes).toEqual([1]);
    expect(errors[0]).toContain("No indexed content for project 'demo'");
    expect(errors[0]).toContain("project-brain sync");
    expect(logs).toEqual([]);
  });

  it("runs the search and logs the rendered result when chunks are indexed", async () => {
    const logs: string[] = [];
    const store = makeStore({
      countChunks: async () => 42,
      ftsSearch: async () => [HIT],
    });

    await runCodeCommand("chargeCard", 10, "demo", store, {
      log: (m) => logs.push(m),
      error: () => {},
      exit: () => { throw new Error("should not exit on success"); },
    });

    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("chargeCard");
  });
});
