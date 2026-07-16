import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("search.ts execute() model resolution wiring (source-level check)", () => {
  // execute() does real filesystem/network I/O — not safely exercisable
  // in-process. Mirrors sync-resolve-model-wiring.test.ts's pattern: assert
  // the wiring exists in source.

  it("reads the project's stored table meta and passes its model into createEmbeddingClient", async () => {
    const src = await readFile(join(import.meta.dir, "../../src/commands/search.ts"), "utf-8");
    expect(src).toContain("await readTableMeta(");
    expect(src).toContain("createEmbeddingClient(storedMeta?.model");
  });
});
