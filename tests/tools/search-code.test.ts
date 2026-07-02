import { describe, it, expect } from "bun:test";
import { handleSearchCode } from "../../src/tools/search-code.js";

describe("search_code", () => {
  it("returns fts hits as structuredContent", async () => {
    const deps = { store: { ftsSearch: async () => [{ id: "a", content: "x", source: "a.ts", module: "src", score: 1 }] } } as any;
    const r = await handleSearchCode({ project: "p", query: "chargeCard", limit: 5 }, deps);
    expect((r.structuredContent as any).results.length).toBe(1);
  });
  it("reports unsupported when store lacks ftsSearch", async () => {
    const r = await handleSearchCode({ project: "p", query: "x" }, { store: {} } as any);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).code).toBe("FTS_UNSUPPORTED");
  });
});
