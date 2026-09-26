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

  /**
   * Claude Code is the one host proven (empirically, via the MCP server
   * `instructions` field it surfaces on connect) to receive the full tool
   * catalog a second time at session start. Its global rules point at that
   * live copy instead of re-embedding TOOL_CATALOG, so this file no longer
   * grows every time a tool is added.
   *
   * `codex`/`gemini` are NOT proven to surface server instructions, so their
   * rules files keep the full catalog as their only source of routing
   * guidance — this test locks that asymmetry in place.
   */
  it("does not duplicate the full tool catalog for 'claude' (the server instructions cover it)", async () => {
    const content = await getGlobalRules("claude");
    expect(content).not.toContain("delete_knowledge");
    expect(content).not.toContain("### Available Tools");
  });

  it("still duplicates the full tool catalog for 'codex' and 'gemini' (no proven instructions surface)", async () => {
    for (const tool of ["codex", "gemini"]) {
      const content = await getGlobalRules(tool);
      expect(content).toContain("delete_knowledge");
    }
  });
});
