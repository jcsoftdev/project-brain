import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { CursorRegistrar } from "../../src/registrars/cursor.js";

describe("CursorRegistrar", () => {
  let registrar: CursorRegistrar;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cursor-reg-"));
    registrar = new CursorRegistrar(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("has name 'Cursor'", () => {
    expect(registrar.name).toBe("Cursor");
  });

  it("isInstalled checks for directory existence", async () => {
    const result = await registrar.isInstalled();
    // tempDir exists so this should be true
    expect(result).toBe(true);
  });

  it("register creates mcp.json with mcpServers entry", async () => {
    await registrar.register("/usr/local/bin/project-brain");

    const configPath = join(tempDir, "mcp.json");
    const config = JSON.parse(await Bun.file(configPath).text());

    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers["project-brain"]).toBeDefined();
    expect(config.mcpServers["project-brain"].command).toBe("bun");
    expect(config.mcpServers["project-brain"].args).toContain(
      "/usr/local/bin/project-brain"
    );
  });

  it("register preserves existing JSON keys", async () => {
    const configPath = join(tempDir, "mcp.json");
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
