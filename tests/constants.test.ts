import { describe, it, expect } from "bun:test";
import { SERVER_INSTRUCTIONS } from "../src/constants.js";

describe("SERVER_INSTRUCTIONS", () => {
  it("is a non-empty string", () => {
    expect(typeof SERVER_INSTRUCTIONS).toBe("string");
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(0);
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
