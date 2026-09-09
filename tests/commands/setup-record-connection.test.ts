import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

async function run(extra: Record<string, unknown> = {}) {
  const { runSetup } = await import("../../src/commands/setup.js");
  const dir = await mkdtemp(join(tmpdir(), "pb-record-conn-"));
  const dataDir = join(dir, "data");

  const result = await runSetup({
    dataDir,
    skipOllama: true,
    skipRegistration: true,
    // Isolate the unit under test: with hosts detected, "hooks:routing" and
    // "hooks:worktree" are not gated by host detection at all (they read
    // Claude Code's own settings.json regardless), so leaving them out of an
    // explicit selection is what keeps this file from touching a settings
    // path it never mentions.
    units: { mode: "explicit", selected: ["config:record-connection"] },
    ...extra,
  });

  const configPath = join(dataDir, "record-config.json");
  const written = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf8")) : null;
  return { result, written, configPath };
}

describe("setup records brain-record's connection preference", () => {
  it("defaults to a fresh, logged-out profile on CDP port 9222", async () => {
    const { result, written } = await run();
    expect(result.recordConnection).toEqual({ mode: "fresh", cdpPort: 9222 });
    expect(written).toEqual({ mode: "fresh", cdpPort: 9222 });
  });

  it("never defaults to live — only an explicit preference opts in", async () => {
    const { result } = await run();
    expect(result.recordConnection.mode).not.toBe("live");
  });

  it("writes the caller-supplied preference verbatim", async () => {
    const { result, written } = await run({
      recordConnection: { mode: "live", cdpPort: 9333 },
    });
    expect(result.recordConnection).toEqual({ mode: "live", cdpPort: 9333 });
    expect(written).toEqual({ mode: "live", cdpPort: 9333 });
  });

  it("writes to <dataDir>/record-config.json by default, never a fixed real-homedir path", async () => {
    // Tying the default to the already-injected dataDir (not a static
    // homedir() constant) is what keeps every OTHER setup test — which never
    // mentions recordConnection at all — from writing into the developer's
    // real ~/.project-brain during a test run.
    const { configPath, written } = await run();
    expect(configPath.startsWith(tmpdir())).toBe(true);
    expect(written).not.toBeNull();
  });

  it("honors an explicit recordConfigPath override", async () => {
    const { runSetup } = await import("../../src/commands/setup.js");
    const dir = await mkdtemp(join(tmpdir(), "pb-record-conn-override-"));
    const dataDir = join(dir, "data");
    const recordConfigPath = join(dir, "elsewhere.json");

    await runSetup({
      dataDir,
      skipOllama: true,
      skipRegistration: true,
      units: { mode: "explicit", selected: ["config:record-connection"] },
      recordConfigPath,
    });

    expect(existsSync(join(dataDir, "record-config.json"))).toBe(false);
    const written = JSON.parse(await readFile(recordConfigPath, "utf8"));
    expect(written).toEqual({ mode: "fresh", cdpPort: 9222 });
  });

  it("is idempotent — a second run overwrites cleanly with the same content", async () => {
    const { runSetup } = await import("../../src/commands/setup.js");
    const dir = await mkdtemp(join(tmpdir(), "pb-record-conn-twice-"));
    const dataDir = join(dir, "data");
    const opts = {
      dataDir,
      skipOllama: true,
      skipRegistration: true,
      units: { mode: "explicit" as const, selected: ["config:record-connection"] },
      recordConnection: { mode: "live" as const, cdpPort: 9400 },
    };

    await runSetup(opts);
    await runSetup(opts);

    const written = JSON.parse(await readFile(join(dataDir, "record-config.json"), "utf8"));
    expect(written).toEqual({ mode: "live", cdpPort: 9400 });
  });
});
