import { describe, it, expect } from "bun:test";
import { NullEmbeddingClient } from "../../src/embeddings/null.js";

describe("NullEmbeddingClient", () => {
  it("has dim=1 and model='none'", () => {
    const client = new NullEmbeddingClient();
    expect(client.dim).toBe(1);
    expect(client.model).toBe("none");
  });

  it("embed() always resolves null regardless of input", async () => {
    const client = new NullEmbeddingClient();
    expect(await client.embed(["a", "b", "c"])).toBeNull();
    expect(await client.embed([])).toBeNull();
  });

  it("isAvailable() always resolves true", async () => {
    const client = new NullEmbeddingClient();
    expect(await client.isAvailable()).toBe(true);
  });
});
