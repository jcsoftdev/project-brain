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
    serviceDir: join(dir, "services"),
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

describe("Jev reranker unit", () => {
  it("ships unchecked and describes what it sends to TypeSafe", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const u = otherUnits().find((x) => x.id === "config:reranker")!;
    expect(u.defaultSelected).toBe(false);
    expect(u.group).toBe("Other");
    expect(u.description).toContain("TypeSafe");
    expect(u.description).toContain("api.typesafe.ai");
    expect(u.description).toContain("84.3%");
    expect(u.description).toContain("0.894");
    expect(u.description).not.toContain("\n");
  });

  it("is absent until a token is written, then current, then absent again on remove", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const u = otherUnits().find((x) => x.id === "config:reranker")!;
    const ctx = await context();
    ctx.rerankerToken = "sk-explicit-token";

    expect(await u.inspect(ctx)).toBe("absent");
    await u.apply(ctx);
    expect(await u.inspect(ctx)).toBe("current");

    const { rerankerTokenPath } = await import("../../src/rerank/token.js");
    expect(JSON.parse(await Bun.file(rerankerTokenPath(ctx.dataDir)).text())).toEqual({
      token: "sk-explicit-token",
    });

    await u.remove(ctx);
    expect(await u.inspect(ctx)).toBe("absent");

    await rm(ctx.dataDir, { recursive: true, force: true });
  });

  it("falls back to TYPESAFE_API_KEY when no explicit token was passed", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const u = otherUnits().find((x) => x.id === "config:reranker")!;
    const ctx = await context();
    const prev = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "env-token";
    try {
      await u.apply(ctx);
      const { rerankerTokenPath } = await import("../../src/rerank/token.js");
      expect(JSON.parse(await Bun.file(rerankerTokenPath(ctx.dataDir)).text())).toEqual({
        token: "env-token",
      });
    } finally {
      if (prev === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = prev;
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
  });

  it("prompts interactively when injected and no token/flag/env is available", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const u = otherUnits().find((x) => x.id === "config:reranker")!;
    const ctx = await context();
    const prev = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    ctx.promptRerankerToken = async () => "typed-token";
    try {
      await u.apply(ctx);
      const { rerankerTokenPath } = await import("../../src/rerank/token.js");
      expect(JSON.parse(await Bun.file(rerankerTokenPath(ctx.dataDir)).text())).toEqual({
        token: "typed-token",
      });
    } finally {
      if (prev !== undefined) process.env.TYPESAFE_API_KEY = prev;
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
  });

  it("fails the unit with a clear message naming both non-interactive options when no token is available", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const u = otherUnits().find((x) => x.id === "config:reranker")!;
    const ctx = await context();
    const prev = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    // No ctx.rerankerToken, no ctx.promptRerankerToken injected — the real
    // interactive.js prompt runs, and under `bun test` (no TTY) it returns
    // null immediately, exercising the non-interactive failure path.
    try {
      await expect(u.apply(ctx)).rejects.toThrow(/--reranker-token/);
      await expect(u.apply(ctx)).rejects.toThrow(/TYPESAFE_API_KEY/);
      expect(await u.inspect(ctx)).toBe("absent");
    } finally {
      if (prev !== undefined) process.env.TYPESAFE_API_KEY = prev;
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
  });

  it("cancelling the interactive prompt also fails the unit, writing nothing", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const u = otherUnits().find((x) => x.id === "config:reranker")!;
    const ctx = await context();
    const prev = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    ctx.promptRerankerToken = async () => null;
    try {
      await expect(u.apply(ctx)).rejects.toThrow();
      expect(await u.inspect(ctx)).toBe("absent");
    } finally {
      if (prev !== undefined) process.env.TYPESAFE_API_KEY = prev;
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
  });

  it("never logs or throws the token itself", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const u = otherUnits().find((x) => x.id === "config:reranker")!;
    const ctx = await context();
    ctx.rerankerToken = "super-secret-token";
    const logs: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      await u.apply(ctx);
      expect(logs.join("\n")).not.toContain("super-secret-token");
    } finally {
      console.warn = originalWarn;
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
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

  it("adds the flag to every host missing it (dropping the headless flag it contradicts), and strips it again on removal", async () => {
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
      "--autoConnect",
    ]);

    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("absent");
    expect(JSON.parse(await Bun.file(b).text()).mcpServers["chrome-devtools"].args).toEqual(["chrome-devtools-mcp"]);

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

describe("auto-compact window unit", () => {
  async function unitAndContext() {
    const { otherUnits } = await import("../../src/setup/units.js");
    const { AUTO_COMPACT_WINDOW } = await import("../../src/setup/auto-compact.js");
    const unit = otherUnits().find((u) => u.id === "config:auto-compact")!;
    return { unit, ctx: await context(), window: AUTO_COMPACT_WINDOW };
  }

  it("is checked by default — the full window is the exception, not the rule", async () => {
    const { unit } = await unitAndContext();
    expect(unit.defaultSelected).toBe(true);
    expect(unit.group).toBe("Other");
  });

  it("goes absent -> current -> absent without touching the rest of settings.json", async () => {
    const { unit, ctx, window } = await unitAndContext();
    await Bun.write(ctx.claudeSettingsPath, JSON.stringify({ model: "opus", env: { FOO: "1" } }));

    expect(await unit.inspect(ctx)).toBe("absent");
    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("current");
    expect(JSON.parse(await Bun.file(ctx.claudeSettingsPath).text())).toEqual({
      model: "opus",
      env: { FOO: "1" },
      autoCompactWindow: window,
    });

    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("absent");
    expect(JSON.parse(await Bun.file(ctx.claudeSettingsPath).text())).toEqual({
      model: "opus",
      env: { FOO: "1" },
    });
  });

  it("treats a window the user chose as theirs: never overwritten, never removed", async () => {
    const { unit, ctx } = await unitAndContext();
    await Bun.write(ctx.claudeSettingsPath, JSON.stringify({ autoCompactWindow: 700000 }));

    expect(await unit.inspect(ctx)).toBe("foreign");
    await unit.apply(ctx);
    await unit.remove(ctx);
    expect(JSON.parse(await Bun.file(ctx.claudeSettingsPath).text())).toEqual({
      autoCompactWindow: 700000,
    });
  });

  it("refuses to touch a settings.json that is not valid JSON", async () => {
    const { unit, ctx } = await unitAndContext();
    await Bun.write(ctx.claudeSettingsPath, "{ nope");

    expect(await unit.inspect(ctx)).toBe("foreign");
    await unit.apply(ctx);
    expect(await Bun.file(ctx.claudeSettingsPath).text()).toBe("{ nope");
  });
});

describe("commit attribution unit", () => {
  async function unitAndContext() {
    const { otherUnits } = await import("../../src/setup/units.js");
    const unit = otherUnits().find((u) => u.id === "config:no-commit-attribution")!;
    return { unit, ctx: await context() };
  }

  it("ships unchecked — it rewrites what every commit and PR says, in every repo", async () => {
    const { unit } = await unitAndContext();
    expect(unit.defaultSelected).toBe(false);
    expect(unit.group).toBe("Other");
  });

  it("goes absent -> current -> absent without touching the rest of settings.json", async () => {
    const { unit, ctx } = await unitAndContext();
    await Bun.write(ctx.claudeSettingsPath, JSON.stringify({ model: "opus" }));

    expect(await unit.inspect(ctx)).toBe("absent");
    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("current");
    expect(JSON.parse(await Bun.file(ctx.claudeSettingsPath).text())).toEqual({
      model: "opus",
      attribution: { commit: "", pr: "" },
    });

    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("absent");
    expect(JSON.parse(await Bun.file(ctx.claudeSettingsPath).text())).toEqual({ model: "opus" });
  });

  it("treats attribution text the user wrote as theirs: never overwritten, never removed", async () => {
    const { unit, ctx } = await unitAndContext();
    const mine = { attribution: { commit: "Assisted-by: Claude", pr: "" } };
    await Bun.write(ctx.claudeSettingsPath, JSON.stringify(mine));

    expect(await unit.inspect(ctx)).toBe("foreign");
    await unit.apply(ctx);
    await unit.remove(ctx);
    expect(JSON.parse(await Bun.file(ctx.claudeSettingsPath).text())).toEqual(mine);
  });
});

describe("a shared chrome-devtools service that is already running", () => {
  // Written in whatever format this platform's service manager reads, under a
  // label that is not ours — the case of a bridge someone set up by hand.
  async function withService(chromeArgs: string[], label = "com.someone.chrome") {
    const { launchdPlist, systemdUnit, serviceKindFor, SERVICE_LABEL } = await import(
      "../../src/setup/chrome-shared-server.js"
    );
    const kind = serviceKindFor(process.platform);
    const ctx = await context();
    ctx.serviceDir = join(ctx.dataDir, "services");
    const spec = {
      port: 39100,
      bridgeBin: "/bin/mcp-proxy",
      command: ["/bin/node", ...chromeArgs],
      logPath: "/tmp/x.log",
      path: "/bin",
    };
    const text = (kind === "launchd" ? launchdPlist(spec) : systemdUnit(spec)).replace(
      SERVICE_LABEL,
      label
    );
    await Bun.write(join(ctx.serviceDir, `${label}.${kind === "launchd" ? "plist" : "service"}`), text);

    const hostConfig = join(ctx.dataDir, "claude.json");
    await Bun.write(
      hostConfig,
      JSON.stringify({ mcpServers: { "chrome-devtools": { type: "http", url: "http://127.0.0.1:39100/mcp" } } })
    );
    ctx.installed = [jsonHost("Claude Code", hostConfig)];
    return { ctx, kind };
  }

  it("reports autoConnect current when the service command carries the flag", async () => {
    const { ctx, kind } = await withService(["chrome-devtools-mcp", "--autoConnect"]);
    if (!kind) return;
    const { otherUnits } = await import("../../src/setup/units.js");
    const unit = otherUnits().find((u) => u.id === "config:chrome-autoconnect")!;

    expect(await unit.inspect(ctx)).toBe("current");
  });

  it("reports autoConnect foreign when the service lacks it — the flag lives in their file", async () => {
    const { ctx, kind } = await withService(["chrome-devtools-mcp"]);
    if (!kind) return;
    const { otherUnits } = await import("../../src/setup/units.js");
    const unit = otherUnits().find((u) => u.id === "config:chrome-autoconnect")!;

    expect(await unit.inspect(ctx)).toBe("foreign");
  });

  it("offers autoConnect as an opt-in on the headless service this tool installed", async () => {
    const { SERVICE_LABEL } = await import("../../src/setup/chrome-shared-server.js");
    const { ctx, kind } = await withService(["chrome-devtools-mcp", "--headless"], SERVICE_LABEL);
    if (!kind) return;
    const { otherUnits } = await import("../../src/setup/units.js");
    const unit = otherUnits().find((u) => u.id === "config:chrome-autoconnect")!;

    expect(unit.defaultSelected).toBe(false);
    expect(await unit.inspect(ctx)).toBe("absent");
  });

  const unitsById = async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    return (id: string) => otherUnits().find((u) => u.id === id)!;
  };
  const stubbed = (ctx: SetupContext) => {
    const calls: string[][] = [];
    ctx.runService = async (argv) => {
      calls.push(argv);
      return 0;
    };
    return calls;
  };
  const serviceText = async (ctx: SetupContext, label: string) => {
    const { serviceKindFor } = await import("../../src/setup/chrome-shared-server.js");
    const ext = serviceKindFor(process.platform) === "launchd" ? "plist" : "service";
    return Bun.file(join(ctx.serviceDir!, `${label}.${ext}`)).text();
  };

  it("moves a service this tool installed on --autoConnect, that nobody opted into, to the headless profile on update", async () => {
    const { SERVICE_LABEL } = await import("../../src/setup/chrome-shared-server.js");
    const unit = await unitsById();
    const legacy = await withService(["chrome-devtools-mcp", "--autoConnect"], SERVICE_LABEL);
    if (!legacy.kind) return;
    const calls = stubbed(legacy.ctx);
    const shared = unit("service:chrome-shared-server");

    // Stale, so `update` (which re-applies only stale units) reaches it; and not mistaken for the owner's choice.
    expect(await shared.inspect(legacy.ctx)).toBe("stale");
    expect(await unit("config:chrome-autoconnect").inspect(legacy.ctx)).toBe("absent");

    await shared.apply(legacy.ctx);

    const text = await serviceText(legacy.ctx, SERVICE_LABEL);
    expect(text).not.toContain("autoConnect");
    expect(text).toContain("--headless");
    expect(text).toContain(`--userDataDir=${join(legacy.ctx.dataDir, "chrome-profile")}`);
    expect(calls.some((c) => c.includes("bootstrap") || c.includes("enable"))).toBe(true);
    expect(await shared.inspect(legacy.ctx)).toBe("current");
  });

  it("keeps --autoConnect once the owner ticked it, and takes it away again when they untick it", async () => {
    const { SERVICE_LABEL } = await import("../../src/setup/chrome-shared-server.js");
    const unit = await unitsById();
    const headless = await withService(["chrome-devtools-mcp", "--headless"], SERVICE_LABEL);
    if (!headless.kind) return;
    stubbed(headless.ctx);
    const autoConnect = unit("config:chrome-autoconnect");
    const shared = unit("service:chrome-shared-server");

    await autoConnect.apply(headless.ctx);
    expect(await serviceText(headless.ctx, SERVICE_LABEL)).toContain("--autoConnect");
    expect(await autoConnect.inspect(headless.ctx)).toBe("current");
    expect(await shared.inspect(headless.ctx)).toBe("current");
    await shared.apply(headless.ctx);
    expect(await serviceText(headless.ctx, SERVICE_LABEL)).toContain("--autoConnect");

    await autoConnect.remove(headless.ctx);
    expect(await serviceText(headless.ctx, SERVICE_LABEL)).not.toContain("--autoConnect");
    expect(await autoConnect.inspect(headless.ctx)).toBe("absent");
  });

  it("leaves a headless service and a service someone else installed as they are", async () => {
    const { SERVICE_LABEL } = await import("../../src/setup/chrome-shared-server.js");
    const unit = await unitsById();
    const shared = unit("service:chrome-shared-server");

    const headless = await withService(["chrome-devtools-mcp", "--headless"], SERVICE_LABEL);
    if (!headless.kind) return;
    expect(await shared.inspect(headless.ctx)).toBe("current");

    const theirs = await withService(["chrome-devtools-mcp", "--autoConnect"]);
    const calls = stubbed(theirs.ctx);
    expect(await shared.inspect(theirs.ctx)).toBe("foreign");
    expect(calls).toEqual([]);
  });

  it("reports a shared server someone else installed as theirs, not as not available", async () => {
    const { ctx, kind } = await withService(["chrome-devtools-mcp", "--autoConnect"]);
    if (!kind) return;
    const { otherUnits } = await import("../../src/setup/units.js");
    const unit = otherUnits().find((u) => u.id === "service:chrome-shared-server")!;

    expect(await unit.inspect(ctx)).toBe("foreign");
  });
});

describe("service:ollama-interactive", () => {
  async function laneContext(platform: string, opts: { failOn?: string; loaded?: boolean; portTaken?: boolean } = {}) {
    const calls: string[][] = [];
    const ctx: SetupContext = {
      ...(await context()),
      skipOllama: false,
      platform,
      ollamaBin: "/opt/homebrew/bin/ollama",
      defaultOllamaServiceFiles: [],
      portAnswers: async () => opts.portTaken ?? false,
      runService: async (argv) => {
        calls.push(argv);
        if (opts.failOn && argv.includes(opts.failOn)) return 5;
        if (argv.includes("print") || argv.includes("is-active")) return opts.loaded === false ? 1 : 0;
        return 0;
      },
    };
    return { ctx, calls };
  }

  async function laneUnit() {
    const { otherUnits } = await import("../../src/setup/units.js");
    return otherUnits().find((u) => u.id === "service:ollama-interactive")!;
  }

  const configOf = async (ctx: SetupContext) => {
    try {
      return JSON.parse(await Bun.file(join(ctx.dataDir, "ollama.json")).text());
    } catch {
      return null;
    }
  };

  it("is off by default", async () => {
    expect((await laneUnit()).defaultSelected).toBe(false);
  });

  it("installs, inspects and removes a launchd agent idempotently, and turns the lane on and off", async () => {
    const { ctx, calls } = await laneContext("darwin");
    const unit = await laneUnit();
    const plist = join(ctx.serviceDir!, "dev.projectbrain.ollama-interactive.plist");
    const uid = process.getuid?.() ?? 0;
    const bootout = ["launchctl", "bootout", `gui/${uid}/dev.projectbrain.ollama-interactive`];

    expect(await unit.inspect(ctx)).toBe("absent");
    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("current");
    expect(await configOf(ctx)).toEqual({ interactiveHost: "http://127.0.0.1:11435" });

    const text = await Bun.file(plist).text();
    expect(text).toContain("<string>/opt/homebrew/bin/ollama</string>");
    expect(text).toContain("<string>serve</string>");
    expect(text).toContain("<key>OLLAMA_HOST</key>\n    <string>127.0.0.1:11435</string>");
    expect(text).toContain("<key>OLLAMA_KEEP_ALIVE</key>\n    <string>-1</string>");
    expect(text).toContain("<key>OLLAMA_MAX_LOADED_MODELS</key>\n    <string>2</string>");
    expect(text).toMatch(/<key>OLLAMA_MODELS<\/key>\n    <string>[^<]+<\/string>/);
    expect(calls.slice(0, 2)).toEqual([bootout, ["launchctl", "bootstrap", `gui/${uid}`, plist]]);

    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("current");

    await Bun.write(plist, text.replace("-1", "5m"));
    expect(await unit.inspect(ctx)).toBe("stale");

    calls.length = 0;
    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("absent");
    expect(calls).toEqual([bootout]);
    expect(await configOf(ctx)).toBeNull();

    await unit.remove(ctx);
    expect(calls).toHaveLength(1);
  });

  it("keeps other keys in ollama.json when removing", async () => {
    const { ctx } = await laneContext("darwin");
    const unit = await laneUnit();
    await unit.apply(ctx);
    await Bun.write(join(ctx.dataDir, "ollama.json"), JSON.stringify({ interactiveHost: "x", other: 1 }));
    await unit.remove(ctx);
    expect(await configOf(ctx)).toEqual({ other: 1 });
  });

  it("reports a written but unloaded service as stale", async () => {
    const { ctx } = await laneContext("darwin", { loaded: false });
    const unit = await laneUnit();
    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("stale");
  });

  it("refuses when another process holds the port, before writing anything", async () => {
    const { ctx } = await laneContext("darwin", { portTaken: true });
    const unit = await laneUnit();
    await expect(unit.apply(ctx)).rejects.toThrow(/port 11435 is already in use/);
    expect(await unit.inspect(ctx)).toBe("absent");
    expect(await configOf(ctx)).toBeNull();
  });

  it("throws and removes the file when bootstrap fails, but tolerates a failing bootout", async () => {
    const { ctx } = await laneContext("darwin", { failOn: "bootstrap" });
    const unit = await laneUnit();
    await expect(unit.apply(ctx)).rejects.toThrow(/bootstrap .* exited with 5/);
    expect(await unit.inspect(ctx)).toBe("absent");
    expect(await configOf(ctx)).toBeNull();

    const tolerant = await laneContext("darwin", { failOn: "bootout" });
    await unit.apply(tolerant.ctx);
    expect(await unit.inspect(tolerant.ctx)).toBe("current");
  });

  it("copies the default instance's runner settings so both produce identical vectors", async () => {
    const { ctx } = await laneContext("darwin");
    const brewPlist = join(ctx.dataDir, "sh.brew.ollama.plist");
    await Bun.write(
      brewPlist,
      `<dict>
		<key>OLLAMA_FLASH_ATTENTION</key>
		<string>1</string>
		<key>OLLAMA_KV_CACHE_TYPE</key>
		<string>q8_0</string>
		<key>OLLAMA_MODELS</key>
		<string>/Volumes/A &amp; B/models</string>
		<key>OLLAMA_HOST</key>
		<string>0.0.0.0:11434</string>
	</dict>`
    );
    ctx.defaultOllamaServiceFiles = [join(ctx.dataDir, "missing.plist"), brewPlist];
    const unit = await laneUnit();
    await unit.apply(ctx);

    const text = await Bun.file(join(ctx.serviceDir!, "dev.projectbrain.ollama-interactive.plist")).text();
    expect(text).toContain("<key>OLLAMA_FLASH_ATTENTION</key>\n    <string>1</string>");
    expect(text).toContain("<key>OLLAMA_KV_CACHE_TYPE</key>\n    <string>q8_0</string>");
    expect(text).toContain("<key>OLLAMA_MODELS</key>\n    <string>/Volumes/A &amp; B/models</string>");
    expect(text).toContain("<key>OLLAMA_HOST</key>\n    <string>127.0.0.1:11435</string>");
    expect(text).not.toContain("0.0.0.0:11434");
  });

  it("reads systemd Environment lines, including several per line", async () => {
    const { serviceDefinitionEnv } = await import("../../src/setup/ollama-interactive.js");
    expect(
      serviceDefinitionEnv(
        '[Service]\nEnvironment="OLLAMA_FLASH_ATTENTION=1"\nEnvironment=OLLAMA_KV_CACHE_TYPE=q8_0 "OLLAMA_MODELS=/srv/my models" PATH=/bin\n'
      )
    ).toEqual({ OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0", OLLAMA_MODELS: "/srv/my models" });
  });

  it("lets drop-ins override the unit, and defaults a system install's models dir", async () => {
    const { defaultInstanceEnv } = await import("../../src/setup/ollama-interactive.js");
    const files: Record<string, string> = {
      "/etc/systemd/system/ollama.service": '[Service]\nEnvironment="OLLAMA_FLASH_ATTENTION=0"\n',
      "/etc/systemd/system/ollama.service.d/10-fa.conf": '[Service]\nEnvironment="OLLAMA_FLASH_ATTENTION=1"\n',
      "/etc/systemd/system/ollama.service.d/20-kv.conf": '[Service]\nEnvironment="OLLAMA_KV_CACHE_TYPE=q8_0"\n',
    };
    const reader = {
      readText: (p: string) => files[p] ?? null,
      listDir: (d: string) => Object.keys(files).filter((p) => p.startsWith(`${d}/`)).map((p) => p.slice(d.length + 1)),
    };
    expect(defaultInstanceEnv(["/home/u/.config/systemd/user/ollama.service", "/etc/systemd/system/ollama.service"], reader, {})).toEqual({
      OLLAMA_FLASH_ATTENTION: "1",
      OLLAMA_KV_CACHE_TYPE: "q8_0",
      OLLAMA_MODELS: "/usr/share/ollama/.ollama/models",
    });
  });

  it("falls back to setup's own environment when no service file exists", async () => {
    const { defaultInstanceEnv } = await import("../../src/setup/ollama-interactive.js");
    const reader = { readText: () => null, listDir: () => [] };
    expect(defaultInstanceEnv(["/nope"], reader, { OLLAMA_FLASH_ATTENTION: "1", HOME: "/h" })).toEqual({
      OLLAMA_FLASH_ATTENTION: "1",
    });
  });

  it("installs a systemd user unit on Linux and checks enable's exit code", async () => {
    const { ctx, calls } = await laneContext("linux");
    const unit = await laneUnit();

    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("current");
    const text = await Bun.file(join(ctx.serviceDir!, "dev.projectbrain.ollama-interactive.service")).text();
    expect(text).toContain("ExecStart=/opt/homebrew/bin/ollama serve");
    expect(text).toContain("Environment=OLLAMA_HOST=127.0.0.1:11435");
    expect(calls.slice(0, 3).map((c) => c.slice(0, 3))).toEqual([
      ["systemctl", "--user", "stop"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable"],
    ]);

    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("absent");

    const failing = await laneContext("linux", { failOn: "enable" });
    await expect(unit.apply(failing.ctx)).rejects.toThrow(/enable/);
    expect(await unit.inspect(failing.ctx)).toBe("absent");
  });

  it("is unavailable on Windows, without ollama, or with --skip-ollama", async () => {
    const unit = await laneUnit();
    expect(await unit.inspect((await laneContext("win32")).ctx)).toBe("unavailable");
    expect(await unit.inspect({ ...(await laneContext("darwin")).ctx, ollamaBin: null })).toBe("unavailable");
    expect(await unit.inspect({ ...(await laneContext("darwin")).ctx, skipOllama: true })).toBe("unavailable");
  });
});
