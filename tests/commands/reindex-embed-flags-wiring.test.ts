import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("reindex.ts execute() embed-model flag/prompt wiring (source-level check)", () => {
  it("parses --no-embed and --embed-model=<key> before creating the embeddings client", async () => {
    const src = await readFile(join(import.meta.dir, "../../src/commands/reindex.ts"), "utf-8");
    expect(src).toContain('args.includes("--no-embed")');
    expect(src).toContain('args.find((a) => a.startsWith("--embed-model="))');
    expect(src).toContain('process.env.BRAIN_EMBED_MODEL = "none"');
  });

  it("calls promptEmbedModel with the stored model as currentModel, before createEmbeddingClient", async () => {
    const src = await readFile(join(import.meta.dir, "../../src/commands/reindex.ts"), "utf-8");
    expect(src).toContain("../embeddings/model-prompt.js");
    expect(src).toContain("currentModel: storedMeta?.model");
    // Ordering: readTableMeta → promptEmbedModel → createEmbeddingClient.
    const readMetaIdx = src.indexOf("await readTableMeta(");
    const promptIdx = src.indexOf("promptEmbedModel({");
    const createClientIdx = src.indexOf("await createEmbeddingClient(resolveSyncModel(");
    expect(readMetaIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeGreaterThan(readMetaIdx);
    expect(createClientIdx).toBeGreaterThan(promptIdx);
  });
});
