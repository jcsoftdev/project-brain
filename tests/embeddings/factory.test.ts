/**
 * Unit tests for createEmbeddingClient factory, ensureEmbeddingModel, detectDim.
 * All tests use injected deps — no real network calls.
 */
import { describe, it, expect } from "bun:test";

// Helper: build a fake embed fn returning vectors of given dimension
function makeEmbed(dim: number) {
  return async (_texts: string[]): Promise<number[][] | null> => [Array(dim).fill(0.1)];
}

// Helper: availability checker that always says the model is available
const alwaysAvailable = async (_model: string) => true;
// Helper: availability checker that always says the model is NOT available
const neverAvailable = async (_model: string) => false;
// Helper: availability checker that throws (Ollama unreachable)
const unreachable = async (_model: string): Promise<boolean> => {
  throw new Error("ECONNREFUSED");
};
// Helper: pull that always succeeds
const pullOk = async (_host: string, _model: string) => true;
// Helper: pull that always fails
const pullFail = async (_host: string, _model: string) => false;

describe("createEmbeddingClient factory", () => {
  it("falls back to nomic-text when code model is unavailable (no autoPull)", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    const client = await createEmbeddingClient(undefined, {
      isModelAvailable: neverAvailable,
      host: "http://127.0.0.1:11434",
    });

    // Must fall back to nomic-embed-text
    expect(client.model).toBe("nomic-embed-text");
  });

  it("uses the requested model when it is available", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    const client = await createEmbeddingClient("nomic-text", {
      isModelAvailable: alwaysAvailable,
      host: "http://127.0.0.1:11434",
    });

    expect(client.model).toBe("nomic-embed-text");
    expect(client.dim).toBe(768);
  });

  it("is tolerant when Ollama is unreachable — uses requested spec as-is", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    const client = await createEmbeddingClient("nomic-text", {
      isModelAvailable: unreachable,
      host: "http://127.0.0.1:11434",
    });

    // When unreachable, use the originally requested model spec (don't block)
    expect(client.model).toBe("nomic-embed-text");
    expect(client.dim).toBe(768);
  });

  it("defaults to qwen3-embedding as the code model key (0.6b fast variant)", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    const client = await createEmbeddingClient(undefined, {
      isModelAvailable: alwaysAvailable,
      host: "http://127.0.0.1:11434",
    });

    // Default resolves to the fast 0.6b variant, not the slow bare 8B tag
    expect(client.model).toBe("qwen3-embedding:0.6b");
  });

  // ── RED: auto-detect dim via injected embed ──────────────────────────────────

  it("RED: auto-detects dim from injected embed returning 1024-length vector", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    const client = await createEmbeddingClient("nomic-text", {
      isModelAvailable: alwaysAvailable,
      host: "http://127.0.0.1:11434",
      embed: makeEmbed(1024),
    });

    // dim must come from the detected vector length, not the registry hint
    expect(client.dim).toBe(1024);
  });

  it("RED: autoPull:true + model absent + pull succeeds → uses requested model", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    let pulled = false;
    const trackingPull = async (_host: string, _model: string) => {
      pulled = true;
      return true;
    };

    const client = await createEmbeddingClient("nomic-text", {
      isModelAvailable: neverAvailable,
      pull: trackingPull,
      embed: makeEmbed(768),
      autoPull: true,
      host: "http://127.0.0.1:11434",
    });

    expect(pulled).toBe(true);
    expect(client.model).toBe("nomic-embed-text");
  });

  it("RED: autoPull:true + model absent + pull fails → falls back to nomic-text", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    const client = await createEmbeddingClient(undefined, {
      // default is qwen3-embedding; pull fails → must fall back to nomic-text
      isModelAvailable: neverAvailable,
      pull: pullFail,
      embed: makeEmbed(768),
      autoPull: true,
      host: "http://127.0.0.1:11434",
    });

    expect(client.model).toBe("nomic-embed-text");
  });

  it("RED: autoPull:false + model absent → does NOT call pull, falls back to nomic-text", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    let pullCalled = false;
    const trackingPull = async (_host: string, _model: string) => {
      pullCalled = true;
      return true;
    };

    const client = await createEmbeddingClient(undefined, {
      isModelAvailable: neverAvailable,
      pull: trackingPull,
      embed: makeEmbed(768),
      autoPull: false,
      host: "http://127.0.0.1:11434",
    });

    expect(pullCalled).toBe(false);
    expect(client.model).toBe("nomic-embed-text");
  });

  it("falls back to registry dim (1024) for qwen3-embedding when detectDim fails, not the hardcoded 768", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    // detectDim fails (e.g. fresh pull, Ollama still warming up) — embed resolves to null.
    const failingEmbed = async (_texts: string[]): Promise<number[][] | null> => null;

    const client = await createEmbeddingClient("qwen3-embedding", {
      isModelAvailable: alwaysAvailable,
      host: "http://127.0.0.1:11434",
      embed: failingEmbed,
    });

    // Must fall back to the registry's documented dim (1024), never the hardcoded 768 (nomic's dim).
    expect(client.dim).toBe(1024);
  });

  it("accepts a raw ollama model name (not a registry key) as modelKey", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    // "nomic-embed-text" is a raw ollama model name, not a registry key like "nomic-text"
    const client = await createEmbeddingClient("nomic-embed-text", {
      isModelAvailable: alwaysAvailable,
      host: "http://127.0.0.1:11434",
      embed: makeEmbed(512),
    });

    expect(client.model).toBe("nomic-embed-text");
    expect(client.dim).toBe(512); // detected via injected embed
  });
});

describe("ensureEmbeddingModel", () => {
  it("RED: returns true when model is already available", async () => {
    const { ensureEmbeddingModel } = await import("../../src/embeddings/factory.js");

    const result = await ensureEmbeddingModel("http://127.0.0.1:11434", "nomic-embed-text", {
      isAvailable: alwaysAvailable,
    });

    expect(result).toBe(true);
  });

  it("RED: returns true when model not present but pull succeeds", async () => {
    const { ensureEmbeddingModel } = await import("../../src/embeddings/factory.js");

    const result = await ensureEmbeddingModel("http://127.0.0.1:11434", "some-model", {
      isAvailable: neverAvailable,
      pull: pullOk,
    });

    expect(result).toBe(true);
  });

  it("RED: returns false when model not present and pull fails", async () => {
    const { ensureEmbeddingModel } = await import("../../src/embeddings/factory.js");

    const result = await ensureEmbeddingModel("http://127.0.0.1:11434", "some-model", {
      isAvailable: neverAvailable,
      pull: pullFail,
    });

    expect(result).toBe(false);
  });

  it("RED: returns false when ollama is unreachable (tolerant)", async () => {
    const { ensureEmbeddingModel } = await import("../../src/embeddings/factory.js");

    const result = await ensureEmbeddingModel("http://127.0.0.1:11434", "some-model", {
      isAvailable: unreachable,
    });

    expect(result).toBe(false);
  });
});

describe("detectDim", () => {
  it("RED: returns dim from embed result length", async () => {
    const { detectDim } = await import("../../src/embeddings/factory.js");

    const dim = await detectDim("http://127.0.0.1:11434", "nomic-embed-text", {
      embed: makeEmbed(768),
    });

    expect(dim).toBe(768);
  });

  it("RED: returns null when embed fails", async () => {
    const { detectDim } = await import("../../src/embeddings/factory.js");

    const dim = await detectDim("http://127.0.0.1:11434", "nomic-embed-text", {
      embed: async () => null,
    });

    expect(dim).toBeNull();
  });
});
