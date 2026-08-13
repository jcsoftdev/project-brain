import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  mergeRoutingConfig,
  loadRoutingConfig,
} from "../../src/rules/model-routing-config.js";
import { MODEL_ROUTING, DEFAULT_HOST_MODELS } from "../../src/constants.js";

async function configFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pb-routing-"));
  const path = join(dir, "model-routing.json");
  await writeFile(path, contents);
  return path;
}

describe("mergeRoutingConfig", () => {
  it("returns the built-ins untouched when there is no config", () => {
    const resolved = mergeRoutingConfig(null);
    expect(resolved.rules).toEqual([...MODEL_ROUTING]);
    expect(resolved.models.claude).toEqual(DEFAULT_HOST_MODELS.claude!);
  });

  it("overrides only the tiers a partial host map names", () => {
    const resolved = mergeRoutingConfig({ models: { claude: { deep: "fable" } } });
    expect(resolved.models.claude).toEqual({
      fast: "haiku",
      balanced: "sonnet",
      deep: "fable",
    });
  });

  it("accepts a host the built-ins never heard of", () => {
    const resolved = mergeRoutingConfig({
      models: { mystery: { fast: "m-1", balanced: "m-2", deep: "m-3" } },
    });
    expect(resolved.models.mystery).toEqual({ fast: "m-1", balanced: "m-2", deep: "m-3" });
  });

  it("appends a rule the built-ins do not have", () => {
    const resolved = mergeRoutingConfig({
      rules: [{ task: "Write a migration", tier: "deep", why: "irreversible" }],
    });
    expect(resolved.rules.length).toBe(MODEL_ROUTING.length + 1);
    expect(resolved.rules.at(-1)).toEqual({
      task: "Write a migration",
      tier: "deep",
      why: "irreversible",
    });
  });

  it("replaces a built-in rule whose task matches, rather than duplicating it", () => {
    const task = MODEL_ROUTING[0]!.task;
    const resolved = mergeRoutingConfig({ rules: [{ task, tier: "deep", why: "mine" }] });

    expect(resolved.rules.length).toBe(MODEL_ROUTING.length);
    const matches = resolved.rules.filter((r) => r.task === task);
    expect(matches.length).toBe(1);
    expect(matches[0]!.tier).toBe("deep");
  });

  it("keeps the built-in reason when an override omits one", () => {
    const original = MODEL_ROUTING[0]!;
    const resolved = mergeRoutingConfig({ rules: [{ task: original.task, tier: "deep" }] });
    expect(resolved.rules.find((r) => r.task === original.task)!.why).toBe(original.why);
  });

  it("drops a rule with an unknown tier instead of rendering nonsense", () => {
    const resolved = mergeRoutingConfig({
      // deliberately invalid — a hand-edited config is untrusted input
      rules: [{ task: "Bogus", tier: "turbo" as never, why: "nope" }],
    });
    expect(resolved.rules.some((r) => r.task === "Bogus")).toBe(false);
    expect(resolved.warnings.some((w) => w.includes("turbo"))).toBe(true);
  });

  it("never mutates the built-in constants", () => {
    const before = JSON.stringify(MODEL_ROUTING);
    mergeRoutingConfig({
      models: { claude: { deep: "fable" } },
      rules: [{ task: "Write a migration", tier: "deep", why: "irreversible" }],
    });
    expect(JSON.stringify(MODEL_ROUTING)).toBe(before);
  });
});

describe("loadRoutingConfig", () => {
  it("falls back to built-ins when the file does not exist", async () => {
    const resolved = await loadRoutingConfig(join(tmpdir(), "pb-nope", "model-routing.json"));
    expect(resolved.rules).toEqual([...MODEL_ROUTING]);
    expect(resolved.warnings).toEqual([]);
  });

  it("warns and falls back on malformed JSON — a bad config must not fail setup", async () => {
    const path = await configFile("{ not json");
    const resolved = await loadRoutingConfig(path);

    expect(resolved.rules).toEqual([...MODEL_ROUTING]);
    expect(resolved.warnings.length).toBeGreaterThan(0);
  });

  it("warns and falls back when the top level is not an object", async () => {
    const path = await configFile("[1, 2, 3]");
    const resolved = await loadRoutingConfig(path);

    expect(resolved.rules).toEqual([...MODEL_ROUTING]);
    expect(resolved.warnings.length).toBeGreaterThan(0);
  });

  it("applies a well-formed config", async () => {
    const path = await configFile(
      JSON.stringify({ version: 1, models: { claude: { fast: "custom-fast" } } })
    );
    const resolved = await loadRoutingConfig(path);
    expect(resolved.models.claude!.fast).toBe("custom-fast");
  });
});
