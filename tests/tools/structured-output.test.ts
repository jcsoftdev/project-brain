import { describe, it, expect } from "bun:test";
import { jsonResult } from "../../src/tools/format.js";
import { handleForget } from "../../src/tools/forget.js";
import { handleSearch } from "../../src/tools/search.js";

describe("jsonResult", () => {
  it("returns both content text and structuredContent with the same payload", () => {
    const r = jsonResult({ a: 1, b: "x" });
    expect(r.structuredContent).toEqual({ a: 1, b: "x" });
    expect(JSON.parse(r.content[0].text)).toEqual({ a: 1, b: "x" });
    expect(r.isError).toBeUndefined();
  });
  it("marks errors", () => {
    expect(jsonResult({ error: "boom" }, true).isError).toBe(true);
  });
});

describe("handlers emit structuredContent", () => {
  it("delete_knowledge result carries structuredContent", async () => {
    const deps = { store: { deleteBySource: async () => {} } } as any;
    const r = await handleForget({ project: "p", source: "s" }, deps);
    expect(r.structuredContent).toEqual({ source: "s", status: "deleted" });
  });
  it("search_context error path carries structuredContent", async () => {
    const deps = { embeddings: { embed: async () => null, dim: 4 }, store: {} } as any;
    const r = await handleSearch({ project: "p", query: "q" }, deps);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).code).toBe("EMBEDDINGS_UNAVAILABLE");
  });
});
