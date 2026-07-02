import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ZedRegistrar } from "../../src/registrars/zed.js";

describe("ZedRegistrar", () => {
  let registrar: ZedRegistrar;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zed-reg-"));
    registrar = new ZedRegistrar(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("has name 'Zed'", () => {
    expect(registrar.name).toBe("Zed");
  });

  it("isInstalled is false when baseDir does not exist", async () => {
    const missing = new ZedRegistrar(join(tempDir, "does-not-exist"));
    expect(await missing.isInstalled()).toBe(false);
  });

  it("isInstalled is true when baseDir exists", async () => {
    expect(await registrar.isInstalled()).toBe(true);
  });

  // Doc-verified against zed.dev/docs/ai/mcp (2026-07): context_servers entries
  // use a flat { command, args } shape, not a nested command:{path,args} object.
  it("register creates settings.json with context_servers entry", async () => {
    await registrar.register("/usr/local/bin/project-brain");

    const configPath = join(tempDir, "settings.json");
    const config = JSON.parse(await Bun.file(configPath).text());

    expect(config.context_servers).toBeDefined();
    expect(config.context_servers["project-brain"].command).toBe("bun");
    expect(config.context_servers["project-brain"].args).toContain(
      "/usr/local/bin/project-brain"
    );
  });

  it("register preserves pre-existing unrelated settings.json keys", async () => {
    const configPath = join(tempDir, "settings.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        theme: "One Dark",
        vim_mode: true,
        context_servers: { other: { command: "bar", args: [] } },
      })
    );

    await registrar.register("/usr/local/bin/project-brain");

    const config = JSON.parse(await Bun.file(configPath).text());
    expect(config.theme).toBe("One Dark");
    expect(config.vim_mode).toBe(true);
    expect(config.context_servers.other).toBeDefined();
    expect(config.context_servers["project-brain"]).toBeDefined();
  });

  it("writeRules is a no-op (Zed has no rules directory)", async () => {
    await expect(registrar.writeRules("irrelevant")).resolves.toBeUndefined();
  });
});
