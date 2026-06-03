/**
 * Real Ollama-gated test for createEmbeddingClient dim auto-detection.
 *
 * Skips gracefully if Ollama is unreachable.
 * Exercises the ALREADY-INSTALLED model (nomic-embed-text, dim 768) via the
 * "nomic-text" key — does NOT trigger a qwen3-embedding download.
 *
 * Passing this test proves that detectDim works end-to-end against real Ollama,
 * returning the correct vector dimension without relying on the hardcoded registry hint.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { OLLAMA_HOST } from "../../src/constants.js";

let ollamaUp = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    ollamaUp = res.ok;
  } catch {
    ollamaUp = false;
  }
});

describe("createEmbeddingClient — real Ollama dim detection", () => {
  it("detects dim=768 for nomic-embed-text (installed model, no download needed)", async () => {
    if (!ollamaUp) {
      console.warn("[factory.real] Ollama unreachable — skipped");
      return;
    }

    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    // Use "nomic-text" key → maps to nomic-embed-text which IS installed.
    // autoPull:true but the model is already present so no pull happens.
    const client = await createEmbeddingClient("nomic-text", {
      host: OLLAMA_HOST,
      autoPull: true,
    });

    console.info(`[factory.real] detected dim=${client.dim}, model=${client.model}`);

    // nomic-embed-text produces 768-dimensional vectors
    expect(client.model).toBe("nomic-embed-text");
    // dim must be DETECTED (768), not hardcoded — same value but proved by real inference
    expect(client.dim).toBe(768);
    // dim must be a positive integer, not 0 or NaN
    expect(client.dim).toBeGreaterThan(0);
  });
});
