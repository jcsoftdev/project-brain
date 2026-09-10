import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AIToolRegistrar } from "../../src/registrars/types.js";
import type { SetupContext } from "../../src/setup/units.js";

async function context(): Promise<SetupContext> {
  const dir = await mkdtemp(join(tmpdir(), "pb-other-"));
  return {
    dataDir: join(dir, "data"),
    installed: [],
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

describe("other units", () => {
  it("writes and deletes the brain-record connection config", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const unit = otherUnits().find((u) => u.id === "config:record-connection")!;

    expect(await unit.inspect(ctx)).toBe("absent");
    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("current");
    expect(JSON.parse(await Bun.file(ctx.recordConfigPath).text())).toEqual({
      mode: "fresh",
      cdpPort: 9222,
    });
    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("absent");

    await rm(ctx.dataDir, { recursive: true, force: true });
  });

  it("reports the record config stale when the on-disk value differs", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const unit = otherUnits().find((u) => u.id === "config:record-connection")!;

    await unit.apply(ctx);
    ctx.recordConnection.cdpPort = 9333;

    expect(await unit.inspect(ctx)).toBe("stale");

    await rm(ctx.dataDir, { recursive: true, force: true });
  });

  it("never deletes the Ollama model on remove", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const unit = otherUnits().find((u) => u.id === "embed:ollama-model")!;

    // Must not throw and must not shell out.
    await unit.remove(ctx);
    expect(unit.description).toContain("shared");
  });
});

/** A registrar that owns one JSON MCP config file, and nothing else. */
function jsonHost(name: string, path: string): AIToolRegistrar {
  return {
    name,
    async isInstalled() {
      return true;
    },
    async register() {},
    async writeRules() {},
    mcpConfigTarget() {
      return { path, containerKey: "mcpServers" };
    },
  };
}

const chromeEntry = (args: string[]) => ({ command: "npx", args });

describe("chrome-devtools autoConnect unit", () => {
  it("is never checked by default — it hands over the real browser", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const unit = otherUnits().find((u) => u.id === "config:chrome-autoconnect")!;

    expect(unit.defaultSelected).toBe(false);
    expect(unit.group).toBe("Other");
  });

  it("is unavailable when no detected host runs the chrome-devtools MCP", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const configPath = join(ctx.dataDir, "host.json");
    await Bun.write(
      configPath,
      JSON.stringify({ mcpServers: { "project-brain": { command: "project-brain", args: [] } } })
    );
    ctx.installed = [jsonHost("Claude Code", configPath)];

    const unit = otherUnits().find((u) => u.id === "config:chrome-autoconnect")!;
    expect(await unit.inspect(ctx)).toBe("unavailable");

    await rm(ctx.dataDir, { recursive: true, force: true });
  });

  it("adds the flag to every host missing it, and strips it again on removal", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const a = join(ctx.dataDir, "a.json");
    const b = join(ctx.dataDir, "b.json");
    await Bun.write(
      a,
      JSON.stringify({
        mcpServers: { chrome: chromeEntry(["-y", "chrome-devtools-mcp@latest"]) },
      })
    );
    await Bun.write(
      b,
      JSON.stringify({
        mcpServers: { "chrome-devtools": chromeEntry(["chrome-devtools-mcp", "--headless"]) },
      })
    );
    ctx.installed = [jsonHost("Claude Code", a), jsonHost("Cursor", b)];

    const unit = otherUnits().find((u) => u.id === "config:chrome-autoconnect")!;
    expect(await unit.inspect(ctx)).toBe("absent");

    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("current");
    expect(JSON.parse(await Bun.file(a).text()).mcpServers.chrome.args).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--autoConnect",
    ]);
    expect(JSON.parse(await Bun.file(b).text()).mcpServers["chrome-devtools"].args).toEqual([
      "chrome-devtools-mcp",
      "--headless",
      "--autoConnect",
    ]);

    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("absent");
    expect(JSON.parse(await Bun.file(b).text()).mcpServers["chrome-devtools"].args).toEqual([
      "chrome-devtools-mcp",
      "--headless",
    ]);

    await rm(ctx.dataDir, { recursive: true, force: true });
  });

  it("is absent while any host still lacks the flag", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const a = join(ctx.dataDir, "a.json");
    const b = join(ctx.dataDir, "b.json");
    await Bun.write(
      a,
      JSON.stringify({ mcpServers: { chrome: chromeEntry(["chrome-devtools-mcp", "--autoConnect"]) } })
    );
    await Bun.write(
      b,
      JSON.stringify({ mcpServers: { chrome: chromeEntry(["chrome-devtools-mcp"]) } })
    );
    ctx.installed = [jsonHost("Claude Code", a), jsonHost("Cursor", b)];

    const unit = otherUnits().find((u) => u.id === "config:chrome-autoconnect")!;
    expect(await unit.inspect(ctx)).toBe("absent");

    await rm(ctx.dataDir, { recursive: true, force: true });
  });

  it("leaves an entry wired to a browser another way alone", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const configPath = join(ctx.dataDir, "host.json");
    const args = ["chrome-devtools-mcp", "--browserUrl", "http://127.0.0.1:9222"];
    await Bun.write(configPath, JSON.stringify({ mcpServers: { chrome: chromeEntry(args) } }));
    ctx.installed = [jsonHost("Claude Code", configPath)];

    const unit = otherUnits().find((u) => u.id === "config:chrome-autoconnect")!;
    expect(await unit.inspect(ctx)).toBe("unavailable");

    await unit.apply(ctx);
    expect(JSON.parse(await Bun.file(configPath).text()).mcpServers.chrome.args).toEqual(args);

    await rm(ctx.dataDir, { recursive: true, force: true });
  });

  it("survives a host whose config file is absent or unreadable", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    ctx.installed = [jsonHost("Claude Code", join(ctx.dataDir, "missing.json"))];

    const unit = otherUnits().find((u) => u.id === "config:chrome-autoconnect")!;
    expect(await unit.inspect(ctx)).toBe("unavailable");
    await unit.apply(ctx);
    await unit.remove(ctx);

    await rm(ctx.dataDir, { recursive: true, force: true });
  });
});

describe("allUnits", () => {
  it("returns every group with unique ids, hosts first", async () => {
    const { allUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const units = allUnits(ctx);
    const ids = units.map((u) => u.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(units.filter((u) => u.group === "Skills").length).toBeGreaterThan(0);
    expect(ids).toContain("guidance:model-routing");
    expect(ids).toContain("embed:ollama-model");
  });

  it("has a unit for every shipped skill manifest", async () => {
    const { allUnits } = await import("../../src/setup/units.js");
    const { SKILL_MANIFESTS } = await import("../../src/rules/skills.js");
    const ctx = await context();
    const ids = new Set(allUnits(ctx).map((u) => u.id));

    for (const name of Object.keys(SKILL_MANIFESTS)) {
      expect(ids.has(`skill:${name}`)).toBe(true);
    }
  });
});
