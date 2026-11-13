import { describe, it, expect } from "bun:test";
import { generateConceptDoc, normalizeConceptDoc } from "../../src/concept/generate.js";
import type { LlmClient } from "../../src/llm/client.js";

const FULL = "## Purpose\n\nHandles login.\n\n## Key Files\n\nlogin.ts\n\n## Dependencies\n\nNone.\n\n## Data Flow\n\nIn, out.\n\n## Gotchas\n\nNone.";

describe("generateConceptDoc", () => {
  it("sends the built prompt to the llm client and returns the trimmed doc", async () => {
    let capturedPrompt = "";
    const mockLlm: LlmClient = {
      complete: async (prompt) => {
        capturedPrompt = prompt;
        return `  ${FULL}\n  `;
      },
    };

    const doc = await generateConceptDoc(
      { module: "auth", commitMessage: "feat(auth): add login", diff: "+export function login() {}", existingDoc: "" },
      mockLlm
    );

    expect(doc).toBe(FULL);
    expect(capturedPrompt).toContain("feat(auth): add login");
    expect(capturedPrompt).toContain("auth");
  });
});

describe("normalizeConceptDoc", () => {
  it("drops a preamble and a wrapping code fence", () => {
    expect(normalizeConceptDoc(`Here is the updated summary:\n\n\`\`\`markdown\n${FULL}\n\`\`\``)).toBe(FULL);
  });

  it("rejects a doc with a missing, out-of-order or truncated section", () => {
    expect(() => normalizeConceptDoc("Sorry, I cannot help with that.")).toThrow("## Purpose");
    expect(() => normalizeConceptDoc(FULL.replace("## Dependencies", "## Deps"))).toThrow("## Dependencies");
    expect(() => normalizeConceptDoc(FULL.slice(0, FULL.indexOf("## Gotchas")))).toThrow("## Gotchas");
    const swapped = FULL.replace("## Key Files", "## TMP").replace("## Data Flow", "## Key Files").replace("## TMP", "## Data Flow");
    expect(() => normalizeConceptDoc(swapped)).toThrow();
  });
});
