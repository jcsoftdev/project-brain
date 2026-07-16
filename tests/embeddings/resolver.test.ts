/**
 * Unit tests for makeEmbeddingResolver.
 * All network calls are injected — no real Ollama or filesystem access.
 */
import { describe, it, expect } from "bun:test";
import type { EmbeddingClient } from "../../src/types.js";

function makeClient(model: string, dim: number): EmbeddingClient {
  return {
    model,
    dim,
    embed: async (texts) => texts.map(() => new Array(dim).fill(0.1)),
    isAvailable: async () => true,
  };
}

describe("makeEmbeddingResolver", () => {
  it("returns defaultClient when meta is null", async () => {
    const { makeEmbeddingResolver } = await import("../../src/embeddings/resolver.js");

    const defaultClient = makeClient("qwen3", 2048);
    const resolver = makeEmbeddingResolver({
      dbPath: "/fake/db",
      host: "http://localhost:11434",
      defaultClient,
      readMeta: async () => null,
      construct: (_model, _dim) => { throw new Error("should not be called"); },
    });

    const result = await resolver("my-project");
    expect(result).toBe(defaultClient);
  });

  it("returns defaultClient when meta.model matches defaultClient.model", async () => {
    const { makeEmbeddingResolver } = await import("../../src/embeddings/resolver.js");

    const defaultClient = makeClient("qwen3", 2048);
    const resolver = makeEmbeddingResolver({
      dbPath: "/fake/db",
      host: "http://localhost:11434",
      defaultClient,
      readMeta: async () => ({ model: "qwen3", dim: 2048 }),
      construct: (_model, _dim) => { throw new Error("should not be called"); },
    });

    const result = await resolver("my-project");
    expect(result).toBe(defaultClient);
  });

  it("constructs a new client when meta.model differs from defaultClient.model", async () => {
    const { makeEmbeddingResolver } = await import("../../src/embeddings/resolver.js");

    const defaultClient = makeClient("qwen3", 2048);
    const altClient = makeClient("nomic-embed-text", 768);

    let constructCalled = 0;
    const resolver = makeEmbeddingResolver({
      dbPath: "/fake/db",
      host: "http://localhost:11434",
      defaultClient,
      readMeta: async () => ({ model: "nomic-embed-text", dim: 768 }),
      construct: (model, dim) => {
        constructCalled++;
        expect(model).toBe("nomic-embed-text");
        expect(dim).toBe(768);
        return altClient;
      },
    });

    const result = await resolver("my-project");
    expect(result).toBe(altClient);
    expect(constructCalled).toBe(1);
  });

  it("caches constructed client — construct called only once across two calls for same model+dim", async () => {
    const { makeEmbeddingResolver } = await import("../../src/embeddings/resolver.js");

    const defaultClient = makeClient("qwen3", 2048);
    const altClient = makeClient("nomic-embed-text", 768);

    let constructCalled = 0;
    const resolver = makeEmbeddingResolver({
      dbPath: "/fake/db",
      host: "http://localhost:11434",
      defaultClient,
      readMeta: async () => ({ model: "nomic-embed-text", dim: 768 }),
      construct: (_model, _dim) => {
        constructCalled++;
        return altClient;
      },
    });

    const r1 = await resolver("project-a");
    const r2 = await resolver("project-b"); // different project, same model+dim → reuse
    expect(r1).toBe(altClient);
    expect(r2).toBe(altClient);
    expect(constructCalled).toBe(1); // cache hit on second call
  });

  it("construct called with correct meta.model and meta.dim", async () => {
    const { makeEmbeddingResolver } = await import("../../src/embeddings/resolver.js");

    const defaultClient = makeClient("qwen3", 2048);
    const constructArgs: Array<[string, number]> = [];

    const resolver = makeEmbeddingResolver({
      dbPath: "/fake/db",
      host: "http://localhost:11434",
      defaultClient,
      readMeta: async (_dbPath, project) => {
        if (project === "proj-a") return { model: "mxbai-embed", dim: 1024 };
        return null;
      },
      construct: (model, dim) => {
        constructArgs.push([model, dim]);
        return makeClient(model, dim);
      },
    });

    await resolver("proj-a");
    expect(constructArgs).toEqual([["mxbai-embed", 1024]]);
  });

  it("routes meta.model === \"none\" to a NullEmbeddingClient, never calling construct", async () => {
    const { makeEmbeddingResolver } = await import("../../src/embeddings/resolver.js");
    const { NullEmbeddingClient } = await import("../../src/embeddings/null.js");

    const defaultClient = makeClient("qwen3", 2048);
    const resolver = makeEmbeddingResolver({
      dbPath: "/fake/db",
      host: "http://localhost:11434",
      defaultClient,
      readMeta: async () => ({ model: "none", dim: 1 }),
      construct: (_model, _dim) => { throw new Error("should not be called for \"none\""); },
    });

    const result = await resolver("lexical-only-project");
    expect(result).toBeInstanceOf(NullEmbeddingClient);
  });

  it("caches the NullEmbeddingClient instance across calls for different \"none\" projects", async () => {
    const { makeEmbeddingResolver } = await import("../../src/embeddings/resolver.js");

    const defaultClient = makeClient("qwen3", 2048);
    const resolver = makeEmbeddingResolver({
      dbPath: "/fake/db",
      host: "http://localhost:11434",
      defaultClient,
      readMeta: async () => ({ model: "none", dim: 1 }),
      construct: (_model, _dim) => { throw new Error("should not be called for \"none\""); },
    });

    const r1 = await resolver("project-a");
    const r2 = await resolver("project-b");
    expect(r1).toBe(r2);
  });
});
