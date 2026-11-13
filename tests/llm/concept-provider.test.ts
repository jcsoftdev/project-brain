import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONCEPT_LLM_MODEL } from "../../src/constants.js";
import { LlmUnavailableError, type LlmClient } from "../../src/llm/client.js";
import {
  createConceptLlm,
  resolveConceptSettings,
  writeConceptConfig,
  yieldToEmbeds,
} from "../../src/llm/concept-provider.js";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pb-concept-provider-"));
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

describe("resolveConceptSettings", () => {
  it("defaults to anthropic and its model with neither env nor config", () => {
    expect(resolveConceptSettings({ env: {}, dataDir })).toEqual({ provider: "anthropic", model: CONCEPT_LLM_MODEL });
  });

  it("uses the config's provider and model, then the provider default when the file names no model", async () => {
    await writeConceptConfig(dataDir, { provider: "ollama", model: "qwen3:8b" });
    expect(resolveConceptSettings({ env: {}, dataDir })).toEqual({ provider: "ollama", model: "qwen3:8b" });
    await writeConceptConfig(dataDir, { provider: "claude-code" });
    expect(resolveConceptSettings({ env: {}, dataDir })).toEqual({ provider: "claude-code", model: "haiku" });
  });

  it("lets the env outrank the config, and never hands the file's model to another provider", async () => {
    await writeConceptConfig(dataDir, { provider: "ollama", model: "qwen3:8b" });
    expect(resolveConceptSettings({ env: { BRAIN_CONCEPT_PROVIDER: "claude-code" }, dataDir })).toEqual({
      provider: "claude-code",
      model: "haiku",
    });
    expect(
      resolveConceptSettings({ env: { BRAIN_CONCEPT_PROVIDER: "Ollama", BRAIN_CONCEPT_MODEL: "qwen3:14b" }, dataDir })
    ).toEqual({ provider: "ollama", model: "qwen3:14b" });
  });

  it("never falls back to anthropic from an unknown env provider", async () => {
    await writeConceptConfig(dataDir, { provider: "ollama" });
    const resolved = resolveConceptSettings({ env: { BRAIN_CONCEPT_PROVIDER: "openai" }, dataDir });
    expect(resolved).toEqual({ invalid: expect.stringContaining('BRAIN_CONCEPT_PROVIDER="openai"') });
  });

  it("reads the file's provider case-insensitively", async () => {
    await writeFile(join(dataDir, "concept.json"), JSON.stringify({ provider: " Ollama " }));
    expect(resolveConceptSettings({ env: {}, dataDir })).toEqual({ provider: "ollama", model: "qwen3.5:4b" });
  });

  it("refuses a truncated file or one naming no known provider, instead of defaulting", async () => {
    for (const content of ['{"provider":"oll', JSON.stringify({ provider: "openai" }), JSON.stringify({ model: "x" })]) {
      await writeFile(join(dataDir, "concept.json"), content);
      const resolved = resolveConceptSettings({ env: {}, dataDir });
      expect("invalid" in resolved, content).toBe(true);
    }
    // A valid env provider decides on its own.
    expect(resolveConceptSettings({ env: { BRAIN_CONCEPT_PROVIDER: "ollama" }, dataDir })).toEqual({
      provider: "ollama",
      model: "qwen3.5:4b",
    });
  });

  it("builds a client for each provider", async () => {
    for (const provider of ["anthropic", "ollama", "claude-code"] as const) {
      const llm = await createConceptLlm({ provider, model: "m" });
      expect(typeof llm.complete).toBe("function");
    }
  });
});

describe("yieldToEmbeds", () => {
  const inner: LlmClient = { complete: async (p) => `done:${p}` };
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("runs at once when nobody is embedding", async () => {
    const llm = yieldToEmbeds(inner, { embedHolder: async () => null, ...clock() });
    expect(await llm.complete("x")).toBe("done:x");
  });

  it("waits while an embed runs, then generates", async () => {
    let polls = 0;
    const llm = yieldToEmbeds(inner, { embedHolder: async () => (polls++ < 3 ? 4242 : null), pollMs: 1000, ...clock() });
    expect(await llm.complete("x")).toBe("done:x");
    expect(polls).toBe(4);
  });

  it("gives up past the budget, shared across calls, with an unavailable error", async () => {
    let busy = true;
    let generated = 0;
    const counting: LlmClient = { complete: async () => String(++generated) };
    const llm = yieldToEmbeds(counting, {
      embedHolder: async () => (busy ? 4242 : null),
      budgetMs: 5000,
      pollMs: 2000,
      ...clock(),
    });
    await expect(llm.complete("a")).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(llm.complete("b")).rejects.toThrow(/busy embedding \(pid 4242\)/);
    busy = false;
    expect(await llm.complete("c")).toBe("1");
  });
});
