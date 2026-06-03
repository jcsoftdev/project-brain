import { describe, expect, it } from "bun:test";
import { resolveModel, DEFAULT_MODEL_KEY } from "../../src/embeddings/registry.js";

describe("model registry", () => {
  it("default is code-specialized", () => {
    const m = resolveModel(undefined);
    expect(m.key).toBe(DEFAULT_MODEL_KEY);
    expect(m.dim).toBeGreaterThan(0);
  });
  it("resolves by key", () => {
    expect(resolveModel("nomic-text").model).toBe("nomic-embed-text");
  });
  it("throws on unknown", () => {
    expect(() => resolveModel("nope")).toThrow();
  });
});
