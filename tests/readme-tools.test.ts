// Drift guard: the README must document every tool in the canonical catalog.
// If a new tool is added to TOOL_CATALOG but not to README.md, this fails — so
// "what the MCP does" can never silently drift out of the docs.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_CATALOG } from "../src/constants.js";
import { resolveModel, DEFAULT_MODEL_KEY } from "../src/embeddings/registry.js";

const README = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

test("README documents every tool in TOOL_CATALOG", () => {
  const missing = TOOL_CATALOG.map((t) => t.name).filter((name) => !README.includes(name));
  expect(missing).toEqual([]);
});

test("README documents the structural layer + update notifier", () => {
  expect(README.toLowerCase()).toContain("structural");
  expect(README).toContain("BRAIN_NO_UPDATE_CHECK");
  expect(README).toContain("OLLAMA_HOST");
});

test("README's documented default embedding model matches the registry default", () => {
  const defaultModel = resolveModel(DEFAULT_MODEL_KEY).model; // e.g. "qwen3-embedding:0.6b"
  expect(README).toContain(defaultModel);
});
