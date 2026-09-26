import { describe, it, expect } from "bun:test";
import { SERVER_INSTRUCTIONS, TOOL_CATALOG } from "../src/constants.js";

describe("SERVER_INSTRUCTIONS", () => {
  it("is a non-empty string", () => {
    expect(typeof SERVER_INSTRUCTIONS).toBe("string");
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(0);
  });

  /**
   * This is now the ONLY full copy of the tool catalog for Claude Code — the
   * global and per-project CLAUDE.md rules point here instead of re-embedding
   * TOOL_CATALOG (see tests/rules/global.test.ts and tests/rules/project.test.ts).
   * A tool missing from this string is a tool Claude Code never learns about at
   * all, so the freshness guard moved here from the project CLAUDE.md test it
   * used to live on.
   */
  it("advertises every tool in TOOL_CATALOG (no stale list)", () => {
    for (const tool of TOOL_CATALOG) {
      expect(SERVER_INSTRUCTIONS).toContain(tool.name);
    }
  });

  it("contains 'semantic' to establish semantic niche", () => {
    expect(SERVER_INSTRUCTIONS).toContain("semantic");
  });

  it("contains 'expand_context' for the two-level workflow", () => {
    expect(SERVER_INSTRUCTIONS).toContain("expand_context");
  });

  it("contains a structural/AST counterpart reference", () => {
    const hasStructural = SERVER_INSTRUCTIONS.includes("structural") || SERVER_INSTRUCTIONS.includes("AST");
    expect(hasStructural).toBe(true);
  });

  it("contains 'WHEN TO USE' trigger guidance", () => {
    expect(SERVER_INSTRUCTIONS).toContain("WHEN TO USE");
  });
});
