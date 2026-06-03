import { describe, expect, it } from "bun:test";
import { handleExpand } from "../../src/tools/expand.js";
import type { ToolDeps } from "../../src/types.js";

const deps = {
  store: { async getChunkById(_p: string, id: string) {
    return id === "a" ? { id: "a", content: "FULL BODY", source: "s.ts", module: "src", vector: [], content_hash: "h", updated_at: 1 } : null;
  } },
} as unknown as ToolDeps;

describe("expand_context", () => {
  it("returns the full body for a chunk_id", async () => {
    const res = await handleExpand({ project: "p", chunk_id: "a" }, deps);
    expect(JSON.parse(res.content[0].text).content).toBe("FULL BODY");
  });
  it("errors for unknown chunk_id", async () => {
    const res = await handleExpand({ project: "p", chunk_id: "z" }, deps);
    expect(res.isError).toBe(true);
  });
});
