import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConceptProviderFlag } from "../../src/cli-args.js";
import { resolveConceptSettings, writeConceptConfig } from "../../src/llm/concept-provider.js";

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "pb-concept-setup-"));
  return { dir, dataDir: join(dir, "data") };
}

async function run(dir: string, dataDir: string, extra: Record<string, unknown> = {}) {
  const { runSetup } = await import("../../src/commands/setup.js");
  const result = await runSetup({
    dataDir,
    skipOllama: true,
    skipRegistration: true,
    // Keeps the hook units off the real ~/.claude/settings.json.
    claudeSettingsPath: join(dir, "settings.json"),
    units: { mode: "explicit", selected: ["config:concept-provider"] },
    promptConceptProvider: async () => null,
    ...extra,
  });
  const configPath = join(dataDir, "concept.json");
  const written = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf8")) : null;
  const row = result.units.find((u) => u.id === "config:concept-provider")!;
  return { written, action: row.action };
}

describe("setup persists the conceptualize backend", () => {
  it("writes the --concept-provider choice to concept.json, where conceptualize reads it", async () => {
    const { dir, dataDir } = await scratch();
    const { written, action } = await run(dir, dataDir, { conceptProvider: "ollama" });
    expect(action).toBe("update");
    expect(written).toEqual({ provider: "ollama" });
    expect(resolveConceptSettings({ env: {}, dataDir })).toEqual({ provider: "ollama", model: "qwen3.5:4b" });
  });

  it("asks when no flag names one, and keeps anthropic when nobody answers", async () => {
    const asked = await scratch();
    let offered: string | undefined;
    const picked = await run(asked.dir, asked.dataDir, {
      promptConceptProvider: async (current: string) => {
        offered = current;
        return "claude-code";
      },
    });
    expect(offered).toBe("anthropic");
    expect(picked.written).toEqual({ provider: "claude-code" });

    const silent = await scratch();
    expect((await run(silent.dir, silent.dataDir)).written).toEqual({ provider: "anthropic" });
  });

  it("leaves a saved choice alone without a flag, and switches it with one", async () => {
    const { dir, dataDir } = await scratch();
    await writeConceptConfig(dataDir, { provider: "ollama", model: "qwen3:8b" });

    const kept = await run(dir, dataDir, {
      promptConceptProvider: async () => {
        throw new Error("a current choice must not be asked again");
      },
    });
    expect(kept.action).toBe("unchanged");
    expect(kept.written).toEqual({ provider: "ollama", model: "qwen3:8b" });

    const switched = await run(dir, dataDir, { conceptProvider: "claude-code" });
    expect(switched.action).toBe("update");
    // The ollama tag would not run on claude, so it does not carry over.
    expect(switched.written).toEqual({ provider: "claude-code" });
  });

  it("keeps the saved choice when a saved selection is re-applied", async () => {
    const { dir, dataDir } = await scratch();
    await run(dir, dataDir, { conceptProvider: "ollama" });
    const { runSetup } = await import("../../src/commands/setup.js");
    await runSetup({
      dataDir,
      skipOllama: true,
      skipRegistration: true,
      claudeSettingsPath: join(dir, "settings.json"),
      applySaved: true,
      quiet: true,
      promptConceptProvider: async () => "anthropic",
    });
    expect(JSON.parse(await readFile(join(dataDir, "concept.json"), "utf8"))).toEqual({ provider: "ollama" });
  });
});

describe("parseConceptProviderFlag", () => {
  it("accepts the three backends, rejects anything else, and is silent when absent", () => {
    expect(parseConceptProviderFlag(["--concept-provider", "claude-code"])).toEqual({ provider: "claude-code" });
    expect(parseConceptProviderFlag(["--concept-provider", "Ollama"])).toEqual({ provider: "ollama" });
    expect(parseConceptProviderFlag([])).toEqual({});
    expect(parseConceptProviderFlag(["--concept-provider", "openai"]).error).toContain("anthropic, ollama or claude-code");
  });
});
