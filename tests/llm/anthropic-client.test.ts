import { describe, it, expect } from "bun:test";

describe("resolveConceptModel", () => {
  it("defaults to the shipped model and honours BRAIN_CONCEPT_MODEL set after import", async () => {
    const { resolveConceptModel } = await import("../../src/llm/anthropic-client.js");
    const { CONCEPT_LLM_MODEL } = await import("../../src/constants.js");
    const saved = process.env.BRAIN_CONCEPT_MODEL;
    try {
      delete process.env.BRAIN_CONCEPT_MODEL;
      expect(resolveConceptModel()).toBe(CONCEPT_LLM_MODEL);
      process.env.BRAIN_CONCEPT_MODEL = "claude-sonnet-5-5";
      expect(resolveConceptModel()).toBe("claude-sonnet-5-5");
      process.env.BRAIN_CONCEPT_MODEL = "  ";
      expect(resolveConceptModel()).toBe(CONCEPT_LLM_MODEL);
    } finally {
      if (saved === undefined) delete process.env.BRAIN_CONCEPT_MODEL;
      else process.env.BRAIN_CONCEPT_MODEL = saved;
    }
  });
});

describe("createAnthropicClient", () => {
  it("returns a client with a complete function, using whatever credentials the host already has", async () => {
    const { createAnthropicClient } = await import("../../src/llm/anthropic-client.js");
    const client = createAnthropicClient();
    expect(client).toBeDefined();
    expect(typeof client.complete).toBe("function");
  });
});
