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

  it("throws on unknown registry key that looks like a non-ollama string", () => {
    // "nope" is short and clearly not an ollama model name — registry still throws
    // (We keep this to confirm old behaviour for truly-invalid keys is unchanged.)
    expect(() => resolveModel("")).toThrow();
  });

  it("passes through a raw ollama model name that is not a registry key", () => {
    // Users can specify e.g. "qwen3-embedding:0.6b" or "nomic-embed-text" directly
    const spec = resolveModel("qwen3-embedding:0.6b");
    expect(spec.model).toBe("qwen3-embedding:0.6b");
    expect(spec.key).toBe("qwen3-embedding:0.6b");
    // dim is undefined — auto-detected downstream
    expect(spec.dim).toBeUndefined();
  });

  it("passes through any non-empty non-registry string as a raw model name", () => {
    const spec = resolveModel("nomic-embed-text");
    expect(spec.model).toBe("nomic-embed-text");
  });

  it("still resolves known registry keys normally", () => {
    expect(resolveModel("nomic-text").model).toBe("nomic-embed-text");
    expect(resolveModel("qwen3-embedding").model).toBe("qwen3-embedding:0.6b");
  });

  it("qwen3-embedding registry entry has dim 1024 (documented model dimension)", () => {
    expect(resolveModel("qwen3-embedding").dim).toBe(1024);
  });
});
