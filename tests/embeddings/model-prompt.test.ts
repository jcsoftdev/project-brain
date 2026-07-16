import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promptEmbedModel, isOllamaAvailable } from "../../src/embeddings/model-prompt.js";

describe("promptEmbedModel", () => {
  let prevEnv: string | undefined;
  let prevTTY: boolean | undefined;

  beforeEach(() => {
    prevEnv = process.env.BRAIN_EMBED_MODEL;
    delete process.env.BRAIN_EMBED_MODEL;
    prevTTY = (process.stdin as any).isTTY;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.BRAIN_EMBED_MODEL;
    else process.env.BRAIN_EMBED_MODEL = prevEnv;
    (process.stdin as any).isTTY = prevTTY;
  });

  it("skips (returns null) when BRAIN_EMBED_MODEL is already set", async () => {
    process.env.BRAIN_EMBED_MODEL = "qwen3-embedding";
    (process.stdin as any).isTTY = true;
    const result = await promptEmbedModel({ ollamaAvailable: true });
    expect(result).toBeNull();
  });

  it("skips (returns null) when stdin is not a TTY", async () => {
    (process.stdin as any).isTTY = false;
    const result = await promptEmbedModel({ ollamaAvailable: true });
    expect(result).toBeNull();
  });

  it("returns the default (1 → qwen3-embedding) on empty input when Ollama is available", async () => {
    (process.stdin as any).isTTY = true;
    const result = await promptEmbedModel({ ollamaAvailable: true, ask: async () => "" });
    expect(result).toBe("qwen3-embedding");
  });

  it("returns the default (3 → none) on empty input when Ollama is unavailable", async () => {
    (process.stdin as any).isTTY = true;
    const result = await promptEmbedModel({ ollamaAvailable: false, ask: async () => "" });
    expect(result).toBe("none");
  });

  it("returns the selected key for a valid numeric answer", async () => {
    (process.stdin as any).isTTY = true;
    const result = await promptEmbedModel({ ollamaAvailable: true, ask: async () => "2" });
    expect(result).toBe("nomic-text");
  });

  it("defaults to keeping the current model on empty input (reindex path)", async () => {
    (process.stdin as any).isTTY = true;
    const result = await promptEmbedModel({
      ollamaAvailable: true,
      currentModel: "none",
      ask: async () => "",
    });
    expect(result).toBe("none");
  });

  it("re-prompts once on invalid input, then falls back to default on a second bad answer", async () => {
    (process.stdin as any).isTTY = true;
    let calls = 0;
    const result = await promptEmbedModel({
      ollamaAvailable: true,
      ask: async () => {
        calls++;
        return "banana";
      },
    });
    expect(calls).toBe(2);
    expect(result).toBe("qwen3-embedding");
  });

  it("accepts a valid answer on the re-prompt after one invalid answer", async () => {
    (process.stdin as any).isTTY = true;
    let calls = 0;
    const result = await promptEmbedModel({
      ollamaAvailable: true,
      ask: async () => {
        calls++;
        return calls === 1 ? "nope" : "3";
      },
    });
    expect(result).toBe("none");
  });
});

describe("isOllamaAvailable", () => {
  // OLLAMA_HOST is read directly from constants.js (not injectable), so this
  // only asserts the function never throws and always resolves a boolean —
  // true/false depends on whether a real Ollama happens to be running on
  // this machine during the test, which is exactly why init/reindex treat
  // it as a soft "pick a sensible default" signal, not a hard requirement.
  it("resolves to a boolean and never throws", async () => {
    const result = await isOllamaAvailable();
    expect(typeof result).toBe("boolean");
  });
});
