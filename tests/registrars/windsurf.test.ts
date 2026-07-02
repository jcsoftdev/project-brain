import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WindsurfRegistrar } from "../../src/registrars/windsurf.js";

describe("WindsurfRegistrar", () => {
  let registrar: WindsurfRegistrar;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "windsurf-reg-"));
    registrar = new WindsurfRegistrar(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("has name 'Windsurf'", () => {
    expect(registrar.name).toBe("Windsurf");
  });

  it("isInstalled is false when baseDir does not exist", async () => {
    const missing = new WindsurfRegistrar(join(tempDir, "does-not-exist"));
    expect(await missing.isInstalled()).toBe(false);
  });

  it("isInstalled is true when baseDir exists", async () => {
    expect(await registrar.isInstalled()).toBe(true);
  });

  it("register creates mcp_config.json with mcpServers entry", async () => {
    await registrar.register("/usr/local/bin/project-brain");

    const configPath = join(tempDir, "mcp_config.json");
    const config = JSON.parse(await Bun.file(configPath).text());

    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers["project-brain"].command).toBe("bun");
    expect(config.mcpServers["project-brain"].args).toContain(
      "/usr/local/bin/project-brain"
    );
  });

  it("register preserves existing unrelated JSON keys", async () => {
    const configPath = join(tempDir, "mcp_config.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        mcpServers: { other: { command: "bar" } },
      })
    );

    await registrar.register("/usr/local/bin/project-brain");

    const config = JSON.parse(await Bun.file(configPath).text());
    expect(config.mcpServers.other).toBeDefined();
    expect(config.mcpServers["project-brain"]).toBeDefined();
  });

  it("writeRules writes to rules/project-brain.md", async () => {
    await registrar.writeRules("Use project-brain MCP.");

    const rulesPath = join(tempDir, "rules", "project-brain.md");
    const content = await Bun.file(rulesPath).text();

    expect(content).toContain("<!-- project-brain:start -->");
    expect(content).toContain("Use project-brain MCP.");
    expect(content).toContain("<!-- project-brain:end -->");
  });
});
