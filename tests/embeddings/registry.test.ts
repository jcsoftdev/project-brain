import { describe, expect, it } from "bun:test";
import { resolveModel, DEFAULT_MODEL_KEY } from "../../src/embeddings/registry.js";

describe("model registry", () => {
  it("default key is qwen3-embedding", () => {
    const m = resolveModel(undefined);
    expect(m.key).toBe(DEFAULT_MODEL_KEY);
  });

  it("default model tag is the fast 0.6b variant", () => {
    const m = resolveModel(undefined);
    // Must use the small/fast variant, NOT bare 'qwen3-embedding' (8B)
    expect(m.model).toBe("qwen3-embedding:0.6b");
  });

  it("resolves by key", () => {
    expect(resolveModel("nomic-text").model).toBe("nomic-embed-text");
  });

  it("throws on unknown", () => {
    expect(() => resolveModel("nope")).toThrow();
  });
});
