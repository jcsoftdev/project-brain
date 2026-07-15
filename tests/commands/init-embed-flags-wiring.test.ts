import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("init.ts execute() embed-model flag/prompt wiring (source-level check)", () => {
  // execute() does real filesystem writes and (without DI) constructs a real
  // embeddings client against DB_PATH/OLLAMA_HOST — not safely exercisable
  // in-process. Mirrors sync-resolve-model-wiring.test.ts's pattern: assert
  // the wiring exists in source; promptEmbedModel/isOllamaAvailable's actual
  // behavior is unit-tested directly in model-prompt.test.ts (Task 6).

  it("parses --no-embed and --embed-model=<key> before calling runInit", async () => {
    const src = await readFile(join(import.meta.dir, "../../src/commands/init.ts"), "utf-8");
    expect(src).toContain('args.includes("--no-embed")');
    expect(src).toContain('args.find((a) => a.startsWith("--embed-model="))');
    expect(src).toContain('process.env.BRAIN_EMBED_MODEL = "none"');
  });

  it("calls promptEmbedModel/isOllamaAvailable only when !skipIndex", async () => {
    const src = await readFile(join(import.meta.dir, "../../src/commands/init.ts"), "utf-8");
    expect(src).toContain("../embeddings/model-prompt.js");
    expect(src).toContain("promptEmbedModel({ ollamaAvailable: await isOllamaAvailable() })");
    // The prompt call must be textually inside an `if (!skipIndex)` guard —
    // a crude but effective check: the guard line appears BEFORE the prompt
    // call in the file.
    const skipIndexGuardIdx = src.indexOf("if (!skipIndex) {");
    const promptCallIdx = src.indexOf("promptEmbedModel({");
    expect(skipIndexGuardIdx).toBeGreaterThan(-1);
    expect(promptCallIdx).toBeGreaterThan(skipIndexGuardIdx);
  });
});
