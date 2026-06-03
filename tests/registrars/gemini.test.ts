import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GeminiRegistrar } from "../../src/registrars/gemini.js";

describe("GeminiRegistrar", () => {
  let registrar: GeminiRegistrar;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gemini-reg-"));
    registrar = new GeminiRegistrar(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("has name 'Gemini CLI'", () => {
    expect(registrar.name).toBe("Gemini CLI");
  });

  it("isInstalled returns boolean based on Bun.which", async () => {
    const result = await registrar.isInstalled();
    expect(typeof result).toBe("boolean");
  });

  it("register creates settings.json with mcpServers entry", async () => {
    await registrar.register("/usr/local/bin/project-brain");

    const configPath = join(tempDir, "settings.json");
    const config = JSON.parse(await Bun.file(configPath).text());

    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers["project-brain"]).toBeDefined();
    expect(config.mcpServers["project-brain"].command).toBe("bun");
    expect(config.mcpServers["project-brain"].args).toContain(
      "/usr/local/bin/project-brain"
    );
  });

  it("register preserves existing JSON keys", async () => {
    const configPath = join(tempDir, "settings.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        mcpServers: { existing: { command: "foo" } },
        otherSetting: true,
      })
    );

    await registrar.register("/usr/local/bin/project-brain");

    const config = JSON.parse(await Bun.file(configPath).text());
    expect(config.otherSetting).toBe(true);
    expect(config.mcpServers.existing).toBeDefined();
    expect(config.mcpServers["project-brain"]).toBeDefined();
  });

  it("writeRules writes to GEMINI.md using section markers", async () => {
    await registrar.writeRules("Use project-brain for context.");

    const rulesPath = join(tempDir, "GEMINI.md");
    const content = await Bun.file(rulesPath).text();

    expect(content).toContain("<!-- project-brain:start -->");
    expect(content).toContain("Use project-brain for context.");
    expect(content).toContain("<!-- project-brain:end -->");
  });
});
