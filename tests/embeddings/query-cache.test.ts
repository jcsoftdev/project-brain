import { describe, it, expect } from "bun:test";
import { QueryEmbedCache } from "../../src/embeddings/query-cache.js";

describe("QueryEmbedCache", () => {
  it("returns undefined on miss, the vector on hit", () => {
    const c = new QueryEmbedCache();
    expect(c.get("m", "how does auth work")).toBeUndefined();
    c.set("m", "how does auth work", [1, 2, 3]);
    expect(c.get("m", "how does auth work")).toEqual([1, 2, 3]);
  });

  it("keys by model AND query — same query, different model = miss", () => {
    const c = new QueryEmbedCache();
    c.set("model-a", "q", [1]);
    expect(c.get("model-b", "q")).toBeUndefined();
  });

  it("evicts least-recently-used beyond capacity", () => {
    const c = new QueryEmbedCache(2);
    c.set("m", "q1", [1]);
    c.set("m", "q2", [2]);
    c.get("m", "q1");          // q1 now most-recently-used
    c.set("m", "q3", [3]);     // evicts q2
    expect(c.get("m", "q1")).toEqual([1]);
    expect(c.get("m", "q2")).toBeUndefined();
    expect(c.get("m", "q3")).toEqual([3]);
  });
});
