import { test, expect } from "bun:test";
import { runExtractSelfTest } from "../../src/commands/extract-selftest.js";

// Mirrors tests/commands/parse-selftest.test.ts's contract: the build-smoke
// hook must verify all three document extractors (pdf/docx/xlsx) actually
// work inside this process — no Ollama, store, or graph DB involved.
test("runExtractSelfTest verifies pdf, docx, and xlsx extraction and returns 3", async () => {
  const count = await runExtractSelfTest();
  expect(count).toBe(3);
});
