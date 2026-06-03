import { describe, expect, it } from "bun:test";
import { resolveModel, DEFAULT_MODEL_KEY } from "../../src/embeddings/registry.js";

describe("model registry", () => {
  it("default is code-specialized", () => {
    const m = resolveModel(undefined);
    expect(m.key).toBe(DEFAULT_MODEL_KEY);
    expect(m.model).toBe("qwen3-embedding");
    // dim is an optional hint — may be undefined for models that support auto-detection
    if (m.dim !== undefined) {
      expect(m.dim).toBeGreaterThan(0);
    }
  });
  it("resolves by key", () => {
    expect(resolveModel("nomic-text").model).toBe("nomic-embed-text");
  });
  it("throws on unknown", () => {
    expect(() => resolveModel("nope")).toThrow();
  });
});
