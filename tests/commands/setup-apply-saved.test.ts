import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AIToolRegistrar } from "../../src/registrars/types.js";
import { readSuggestMarker } from "../../src/hooks/suggest-hook.js";
import { loadSelection } from "../../src/setup/selection.js";
import { runUpdate } from "../../src/commands/update.js";

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

async function harness() {
  const { runSetup } = await import("../../src/commands/setup.js");
  const dir = await mkdtemp(join(tmpdir(), "pb-apply-saved-"));
  const dataDir = join(dir, "data");
  const settingsPath = join(dir, "settings.json");
  const common = { dataDir, skipOllama: true, registrars: [claudeRegistrar()], skillTargetDirs: [], claudeSettingsPath: settingsPath };
  return {
    dataDir,
    settingsPath,
    choose: (selected: string[]) => runSetup({ ...common, units: { mode: "explicit", selected } }),
    apply: () => runSetup({ ...common, applySaved: true, quiet: true }),
    commands: async () => {
      const settings = JSON.parse(await readFile(settingsPath, "utf8").catch(() => "{}"));
      return Object.values(settings.hooks ?? {}).flatMap((groups: any) =>
        (groups as any[]).flatMap((g) => (g.hooks ?? []).map((h: any) => h.command as string))
      );
    },
  };
}

describe("setup applySaved (what `update` runs on the new binary)", () => {
  it("keeps selected hooks, never adds a declined one, and leaves the opt-out marker alone", async () => {
    const h = await harness();
    await h.choose(["hooks:routing"]);
    expect(await readSuggestMarker(h.dataDir)).toBe("opted-out");

    await h.apply();

    const cmds = await h.commands();
    expect(cmds.some((c) => c.includes("routing-rules"))).toBe(true);
    expect(cmds.some((c) => c.includes("suggest --stdin"))).toBe(false);
    expect(await readSuggestMarker(h.dataDir)).toBe("opted-out");
    expect((await loadSelection(join(h.dataDir, "setup-selection.json")))?.declined).toContain("hooks:suggest");
  });

  it("does not remove a declined unit that is found on disk", async () => {
    const h = await harness();
    await h.choose(["hooks:routing"]);
    // The user hand-added the declined suggest hook afterwards.
    const settings = JSON.parse(await readFile(h.settingsPath, "utf8"));
    settings.hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: "project-brain suggest --stdin" }] }];
    await writeFile(h.settingsPath, JSON.stringify(settings));

    await h.apply();

    expect((await h.commands()).some((c) => c.includes("suggest --stdin"))).toBe(true);
  });

  it("with no saved selection, touches only what is installed and installs nothing new", async () => {
    const h = await harness();
    await writeFile(
      h.settingsPath,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "project-brain routing-rules" }] }] } })
    );

    const result = await h.apply();

    expect((await h.commands()).filter((c) => c.includes("project-brain"))).toEqual(["project-brain routing-rules"]);
    expect(result.units.filter((u) => u.action === "install")).toEqual([]);
    // Units never offered stay unseen rather than being recorded as refusals.
    const saved = await loadSelection(join(h.dataDir, "setup-selection.json"));
    expect(saved?.declined).toEqual([]);
  });

  it("is idempotent", async () => {
    const h = await harness();
    await h.choose(["hooks:routing", "hooks:suggest"]);
    const before = await readFile(h.settingsPath, "utf8");
    await h.apply();
    await h.apply();
    expect(await readFile(h.settingsPath, "utf8")).toBe(before);
  });
});

describe("runUpdate re-applies setup", () => {
  const deps = (over: Record<string, unknown> = {}) => {
    const logged: string[] = [];
    const calls: string[] = [];
    return {
      logged,
      calls,
      deps: {
        currentVersion: "0.6.0",
        binPath: "/Users/x/.bun/bin/project-brain",
        env: {} as Record<string, string | undefined>,
        fetchLatest: async () => "0.7.0" as string | null,
        spawnUpdate: async () => (calls.push("install"), 0),
        applySetup: async () => (calls.push("apply"), 0),
        hasSavedSelection: () => true,
        log: (m: string) => logged.push(m),
        ...over,
      },
    };
  };

  it("applies after a successful install, in that order", async () => {
    const h = deps();
    await runUpdate(h.deps);
    expect(h.calls).toEqual(["install", "apply"]);
  });

  it("does not apply when the install failed", async () => {
    const h = deps({ spawnUpdate: async () => 1 });
    await runUpdate(h.deps);
    expect(h.calls).toEqual([]);
  });

  it("--apply-only skips the install and the version check", async () => {
    const h = deps({ applyOnly: true, binPath: "/opt/homebrew/Cellar/project-brain/1/bin/project-brain" });
    await runUpdate(h.deps);
    expect(h.calls).toEqual(["apply"]);
  });

  it("says setup can add more when there is no saved selection", async () => {
    const h = deps({ hasSavedSelection: () => false });
    await runUpdate(h.deps);
    expect(h.logged.join("\n")).toContain("project-brain setup");
  });
});
