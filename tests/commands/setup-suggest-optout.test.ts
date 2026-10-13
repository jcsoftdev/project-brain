import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AIToolRegistrar } from "../../src/registrars/types.js";
import { readSuggestMarker, selfInstallSuggestHook } from "../../src/hooks/suggest-hook.js";

const claudeRegistrar = (): AIToolRegistrar =>
  ({
    name: "Claude Code",
    isInstalled: async () => true,
    register: async () => {},
    writeRules: async () => {},
    routing: {
      hostKey: "claude",
      mechanism: "per-spawn",
      howToApply: "pass `model` on the call.",
      labelField: "the description field",
      models: { fast: "haiku", balanced: "sonnet", deep: "opus" },
    },
    writtenRoutingVersion: async () => null,
    writeModelRouting: async () => {},
  }) as unknown as AIToolRegistrar;

async function setup(selected: string[], seedSettings?: object) {
  const { runSetup } = await import("../../src/commands/setup.js");
  const dir = await mkdtemp(join(tmpdir(), "pb-suggest-optout-"));
  const dataDir = join(dir, "data");
  const settingsPath = join(dir, "settings.json");
  if (seedSettings) await writeFile(settingsPath, JSON.stringify(seedSettings));
  const run = (units: string[]) =>
    runSetup({
      dataDir,
      skipOllama: true,
      registrars: [claudeRegistrar()],
      skillTargetDirs: [],
      units: { mode: "explicit", selected: units },
      claudeSettingsPath: settingsPath,
    });
  await run(selected);
  const userPromptCommands = async () => {
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    return (settings.hooks?.UserPromptSubmit ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command as string));
  };
  return { dataDir, settingsPath, run, userPromptCommands };
}

describe("declining the suggest hook in setup sticks", () => {
  it("first run, left unticked: opted out, so the SessionStart self-install does nothing", async () => {
    const { dataDir, settingsPath, userPromptCommands } = await setup(["hooks:routing"]);

    expect(await readSuggestMarker(dataDir)).toBe("opted-out");
    expect(await selfInstallSuggestHook({ settingsPath, dataDir })).toBe(false);
    expect(await userPromptCommands()).toEqual([]);
  });

  it("upgrade then setup, left unticked: the hook was never added and is not added later", async () => {
    const seeded = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "project-brain routing-rules" }] }] } };
    const { dataDir, settingsPath, userPromptCommands } = await setup(["hooks:routing"], seeded);

    expect(await readSuggestMarker(dataDir)).toBe("opted-out");
    expect(await selfInstallSuggestHook({ settingsPath, dataDir })).toBe(false);
    expect(await userPromptCommands()).toEqual([]);
  });

  it("ticked: installs the hook and records it", async () => {
    const { dataDir, userPromptCommands } = await setup(["hooks:suggest"]);

    expect(await readSuggestMarker(dataDir)).toBe("installed");
    expect((await userPromptCommands()).some((c: string) => c.startsWith("project-brain suggest --stdin"))).toBe(true);
  });
});
