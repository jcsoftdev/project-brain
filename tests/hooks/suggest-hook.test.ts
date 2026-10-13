import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeSuggestHook, SUGGEST_COMMAND, upsertSuggestHook } from "../../src/hooks/claude-settings.js";
import { readSuggestMarker, selfInstallSuggestHook, writeSuggestMarker } from "../../src/hooks/suggest-hook.js";

const commands = (settings: any, event: string): string[] =>
  (settings.hooks?.[event] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command as string));

describe("upsertSuggestHook / removeSuggestHook", () => {
  const existing = {
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "project-brain search --stdin" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    },
  };

  it("adds one UserPromptSubmit group, idempotently, keeping everything else", () => {
    const once: any = upsertSuggestHook(existing);
    const twice: any = upsertSuggestHook(once);

    expect(twice).toEqual(once);
    expect(commands(once, "UserPromptSubmit")).toEqual(["project-brain search --stdin", SUGGEST_COMMAND]);
    expect(once.permissions).toEqual(existing.permissions);
    expect(commands(once, "SessionStart")).toEqual(["echo hi"]);
    expect(once.hooks.UserPromptSubmit[1].hooks[0]).toMatchObject({ timeout: 10, statusMessage: "project-brain: suggesting skill/tool" });
    expect(existing.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it("removal leaves the search hook and other events alone, and is idempotent", () => {
    const removed: any = removeSuggestHook(upsertSuggestHook(existing));
    expect(removed).toEqual(existing);
    expect(removeSuggestHook(removed)).toEqual(removed);
  });
});

describe("selfInstallSuggestHook", () => {
  let dir: string;
  let settingsPath: string;
  let dataDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-selfinstall-"));
    settingsPath = join(dir, "settings.json");
    dataDir = join(dir, "data");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const seed = (obj: unknown) => writeFile(settingsPath, typeof obj === "string" ? obj : JSON.stringify(obj));
  const read = async () => JSON.parse(await readFile(settingsPath, "utf-8"));

  it("installs once, keeps other hooks and keys, and records the marker", async () => {
    await seed({ model: "opus", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "project-brain routing-rules" }] }] } });

    expect(await selfInstallSuggestHook({ settingsPath, dataDir })).toBe(true);
    const settings = await read();
    expect(settings.model).toBe("opus");
    expect(commands(settings, "SessionStart")).toEqual(["project-brain routing-rules"]);
    expect(commands(settings, "UserPromptSubmit")).toEqual([SUGGEST_COMMAND]);
    expect(await readSuggestMarker(dataDir)).toBe("installed");
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("never re-adds after the user removed it", async () => {
    await seed({ hooks: {} });
    await selfInstallSuggestHook({ settingsPath, dataDir });
    await seed({ hooks: {} });

    expect(await selfInstallSuggestHook({ settingsPath, dataDir })).toBe(false);
    expect(commands(await read(), "UserPromptSubmit")).toEqual([]);
  });

  it("never installs after a setup opt-out", async () => {
    await seed({ hooks: {} });
    await writeSuggestMarker(dataDir, "opted-out");

    expect(await selfInstallSuggestHook({ settingsPath, dataDir })).toBe(false);
    expect(commands(await read(), "UserPromptSubmit")).toEqual([]);
  });

  it("records the marker without rewriting when the hook is already there", async () => {
    const original = JSON.stringify(upsertSuggestHook({}));
    await seed(original);

    expect(await selfInstallSuggestHook({ settingsPath, dataDir })).toBe(false);
    expect(await readFile(settingsPath, "utf-8")).toBe(original);
    expect(await readSuggestMarker(dataDir)).toBe("installed");
  });

  it("does nothing, and sets no marker, on malformed or missing settings", async () => {
    await seed("{ not json");
    expect(await selfInstallSuggestHook({ settingsPath, dataDir })).toBe(false);
    expect(await readFile(settingsPath, "utf-8")).toBe("{ not json");
    expect(await readSuggestMarker(dataDir)).toBeNull();

    await rm(settingsPath);
    expect(await selfInstallSuggestHook({ settingsPath, dataDir })).toBe(false);
    expect(await readSuggestMarker(dataDir)).toBeNull();
  });
});
