import { describe, it, expect } from "bun:test";
import { getGlobalRules } from "../../src/rules/global.js";

describe("Global rules loader", () => {
  it("returns content for 'claude' tool", async () => {
    const content = await getGlobalRules("claude");
    expect(content).toContain("project-brain");
    expect(content).toContain("search_context");
  });

  it("returns content for 'codex' tool", async () => {
    const content = await getGlobalRules("codex");
    expect(content).toContain("project-brain");
    expect(content).toContain("search_context");
  });

  it("returns content for 'gemini' tool", async () => {
    const content = await getGlobalRules("gemini");
    expect(content).toContain("project-brain");
    expect(content).toContain("search_context");
  });

  it("returns fallback content for unknown tool", async () => {
    const content = await getGlobalRules("unknown");
    expect(content).toContain("project-brain");
  });
});
