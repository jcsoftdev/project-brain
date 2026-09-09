import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AIToolRegistrar } from "../../src/registrars/types.js";
import type { SetupContext } from "../../src/setup/units.js";

/** A registrar that records what it was asked to do, with no filesystem. */
function fakeRegistrar(name: string) {
  const calls: string[] = [];
  let registered = false;
  const registrar: AIToolRegistrar = {
    name,
    async isInstalled() {
      return true;
    },
    async register(serverPath: string) {
      calls.push(`register:${serverPath}`);
      registered = true;
    },
    async writeRules(content: string) {
      calls.push(`rules:${content.length}`);
    },
  };
  return { registrar, calls, isRegistered: () => registered };
}

async function context(installed: AIToolRegistrar[]): Promise<SetupContext> {
  const dir = await mkdtemp(join(tmpdir(), "pb-hosts-"));
  return {
    dataDir: join(dir, "data"),
    installed,
    serverPath: "/usr/local/bin/project-brain",
    claudeSettingsPath: join(dir, "settings.json"),
    recordConfigPath: join(dir, "record-config.json"),
    selectionPath: join(dir, "setup-selection.json"),
    skillTargetDirs: [join(dir, "skills")],
    recordConnection: { mode: "fresh", cdpPort: 9222 },
    hookStrict: { routing: false, worktree: false },
    skipOllama: true,
  };
}

describe("host units", () => {
  it("builds one unit per detected host, with a slugged id", async () => {
    const { hostUnits } = await import("../../src/setup/units.js");
    const claude = fakeRegistrar("Claude Code");
    const cursor = fakeRegistrar("Cursor");

    const units = hostUnits([claude.registrar, cursor.registrar]);

    expect(units.map((u) => u.id)).toEqual(["host:claudecode", "host:cursor"]);
    expect(units.map((u) => u.label)).toEqual(["Claude Code", "Cursor"]);
    expect(units.every((u) => u.group === "Hosts")).toBe(true);
    expect(units.every((u) => u.defaultSelected)).toBe(true);
  });

  it("registers the MCP server and writes the rules file in one apply", async () => {
    const { hostUnits } = await import("../../src/setup/units.js");
    const claude = fakeRegistrar("Claude Code");
    const ctx = await context([claude.registrar]);

    await hostUnits([claude.registrar])[0]!.apply(ctx);

    expect(claude.calls[0]).toBe("register:/usr/local/bin/project-brain");
    expect(claude.calls[1]?.startsWith("rules:")).toBe(true);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });

  it("reports unavailable when the host is not among the detected ones", async () => {
    const { hostUnits } = await import("../../src/setup/units.js");
    const claude = fakeRegistrar("Claude Code");
    const units = hostUnits([claude.registrar]);
    const ctx = await context([]); // detection later found nothing

    expect(await units[0]!.inspect(ctx)).toBe("unavailable");
  });

  it("uses the registrar's own MCP target to decide current vs absent", async () => {
    const { hostUnits } = await import("../../src/setup/units.js");
    const dir = await mkdtemp(join(tmpdir(), "pb-hosts-cfg-"));
    const configPath = join(dir, "mcp.json");
    const base = fakeRegistrar("Cursor");
    const registrar: AIToolRegistrar = {
      ...base.registrar,
      mcpConfigTarget: () => ({ path: configPath, containerKey: "mcpServers" }),
    };
    const ctx = await context([registrar]);
    const unit = hostUnits([registrar])[0]!;

    expect(await unit.inspect(ctx)).toBe("absent");
    await Bun.write(configPath, JSON.stringify({ mcpServers: { "project-brain": {} } }));
    expect(await unit.inspect(ctx)).toBe("current");

    await rm(dir, { recursive: true, force: true });
  });
});
