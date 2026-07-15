import { describe, it, expect } from "bun:test";

describe("createAnthropicClient", () => {
  it("returns a client with a complete function, using whatever credentials the host already has", async () => {
    const { createAnthropicClient } = await import("../../src/llm/anthropic-client.js");
    const client = createAnthropicClient();
    expect(client).toBeDefined();
    expect(typeof client.complete).toBe("function");
  });
});
