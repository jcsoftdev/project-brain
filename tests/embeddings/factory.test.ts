/**
 * RED tests for FIX 3: createEmbeddingClient factory with safe fallback.
 * Tests are written against the NOT-YET-EXISTING createEmbeddingClient export.
 */
import { describe, it, expect } from "bun:test";

describe("FIX 3: createEmbeddingClient factory", () => {
  it("returns a client using the fallback text model when code model is unavailable", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    // Inject an availability checker that reports the code model as unavailable
    const neverAvailable = async (_model: string) => false;
    const client = await createEmbeddingClient("nomic-code", {
      isModelAvailable: neverAvailable,
      host: "http://127.0.0.1:11434",
    });

    // Must fall back to nomic-embed-text
    expect(client.model).toBe("nomic-embed-text");
    expect(client.dim).toBe(768);
  });

  it("returns a client using the requested model when it is available", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    const alwaysAvailable = async (_model: string) => true;
    const client = await createEmbeddingClient("nomic-text", {
      isModelAvailable: alwaysAvailable,
      host: "http://127.0.0.1:11434",
    });

    expect(client.model).toBe("nomic-embed-text");
    expect(client.dim).toBe(768);
  });

  it("returns a client without erroring when Ollama is unreachable (tolerant probe)", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    // Simulate Ollama unreachable — should NOT throw, should use requested spec
    const unreachable = async (_model: string): Promise<boolean> => {
      throw new Error("ECONNREFUSED");
    };
    const client = await createEmbeddingClient("nomic-code", {
      isModelAvailable: unreachable,
      host: "http://127.0.0.1:11434",
    });

    // When unreachable, use the originally requested model spec (don't block)
    expect(client.model).toBe("nomic-embed-code");
    expect(client.dim).toBe(768);
  });

  it("defaults to code model key when no modelKey passed", async () => {
    const { createEmbeddingClient } = await import("../../src/embeddings/factory.js");

    // When code model is available, should return code model
    const alwaysAvailable = async (_model: string) => true;
    const client = await createEmbeddingClient(undefined, {
      isModelAvailable: alwaysAvailable,
      host: "http://127.0.0.1:11434",
    });

    expect(client.model).toBe("nomic-embed-code");
  });
});
