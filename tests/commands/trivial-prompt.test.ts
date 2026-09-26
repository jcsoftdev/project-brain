import { describe, it, expect } from "bun:test";
import { isTrivialPrompt } from "../../src/commands/trivial-prompt.js";

describe("isTrivialPrompt", () => {
  describe("pure acknowledgement / continuation, any length", () => {
    const cases = [
      "si",
      "yes",
      "dale",
      "ok",
      "no entendi",
      "you sure?",
      "continue",
      "thanks",
      "gracias",
      "perfect",
      "sigue",
      "listo",
      "ok gracias perfecto",
      "yes all",
      "yes yes yes",
      "gracias gracias gracias",
      "ok ok continue",
      "sale pues ok",
    ];

    for (const prompt of cases) {
      it(`"${prompt}" is trivial`, () => {
        expect(isTrivialPrompt(prompt)).toBe(true);
      });
    }
  });

  describe("carries a real code question, however short", () => {
    const cases = [
      "how does the search hook work",
      "explain the sync pipeline",
      "why is chunking slow",
      "thanks so much for the fix",
      "yes please continue with the refactor",
      "okf audit",
      "explain reindex",
      "sync bug",
      "reindex",
    ];

    for (const prompt of cases) {
      it(`"${prompt}" is not trivial`, () => {
        expect(isTrivialPrompt(prompt)).toBe(false);
      });
    }
  });

  describe("code identifier exception overrides short-prompt rule", () => {
    const cases = [
      "fix `runSync`",
      "check user_id",
      "look at handleSearch",
      "src/commands/search.ts",
      "why does src/tools/health.ts fail",
    ];

    for (const prompt of cases) {
      it(`"${prompt}" is not trivial`, () => {
        expect(isTrivialPrompt(prompt)).toBe(false);
      });
    }
  });

  describe("edge cases", () => {
    it("empty string is trivial", () => {
      expect(isTrivialPrompt("")).toBe(true);
    });

    it("whitespace-only string is trivial", () => {
      expect(isTrivialPrompt("   ")).toBe(true);
    });

    it("punctuation-only string is trivial", () => {
      expect(isTrivialPrompt("?!.")).toBe(true);
    });
  });
});
