import { describe, it, expect } from "bun:test";
import { generateConceptDoc } from "../../src/concept/generate.js";
import type { LlmClient } from "../../src/llm/anthropic-client.js";

describe("generateConceptDoc", () => {
  it("sends the built prompt to the llm client and returns the trimmed result", async () => {
    let capturedPrompt = "";
    const mockLlm: LlmClient = {
      complete: async (prompt) => {
        capturedPrompt = prompt;
        return "  ## Purpose\n\nHandles login.\n  ";
      },
    };

    const doc = await generateConceptDoc(
      {
        module: "auth",
        commitMessage: "feat(auth): add login",
        diff: "+export function login() {}",
        existingDoc: "",
      },
      mockLlm
    );

    expect(doc).toBe("## Purpose\n\nHandles login.");
    expect(capturedPrompt).toContain("feat(auth): add login");
    expect(capturedPrompt).toContain("auth");
  });
});
