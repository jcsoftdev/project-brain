import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("sync/reindex execute() model resolution wiring (source-level check)", () => {
  // execute() calls process.exit(1) on failure and does real Ollama network
  // calls via createEmbeddingClient — not safely exercisable in-process.
  // Mirrors reindex.test.ts's "execute() checks result.error..." pattern:
  // assert the wiring exists in source, combined with the behavioral
  // resolveSyncModel unit tests proving the precedence logic itself is correct.

  it("sync.ts execute() calls readTableMeta and passes resolveSyncModel(...) into createEmbeddingClient", async () => {
    const src = await readFile(
      join(import.meta.dir, "../../src/commands/sync.ts"),
      "utf-8"
    );
    expect(src).toContain("await readTableMeta(");
    expect(src).toContain("createEmbeddingClient(resolveSyncModel(");
  });

  it("reindex.ts execute() calls readTableMeta and passes resolveSyncModel(...) into createEmbeddingClient", async () => {
    const src = await readFile(
      join(import.meta.dir, "../../src/commands/reindex.ts"),
      "utf-8"
    );
    expect(src).toContain("await readTableMeta(");
    expect(src).toContain("createEmbeddingClient(resolveSyncModel(");
  });
});
