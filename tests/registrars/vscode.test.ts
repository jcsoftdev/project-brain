import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VSCodeRegistrar } from "../../src/registrars/vscode.js";

describe("VSCodeRegistrar", () => {
  let registrar: VSCodeRegistrar;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vscode-reg-"));
    registrar = new VSCodeRegistrar(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("has name 'VS Code'", () => {
    expect(registrar.name).toBe("VS Code");
  });

  it("isInstalled is false when baseDir does not exist", async () => {
    const missing = new VSCodeRegistrar(join(tempDir, "does-not-exist"));
    expect(await missing.isInstalled()).toBe(false);
  });

  it("isInstalled is true when baseDir exists", async () => {
    expect(await registrar.isInstalled()).toBe(true);
  });

  // Doc-verified against code.visualstudio.com/docs/agents/reference/mcp-configuration:
  // entry key is `servers` (not `mcpServers`).
  it("register creates mcp.json with servers entry", async () => {
    await registrar.register("/usr/local/bin/project-brain");

    const configPath = join(tempDir, "mcp.json");
    const config = JSON.parse(await Bun.file(configPath).text());

    expect(config.servers).toBeDefined();
    expect(config.servers["project-brain"].command).toBe("bun");
    expect(config.servers["project-brain"].args).toContain(
      "/usr/local/bin/project-brain"
    );
  });

  // VS Code MCP schema uses `type: "stdio"`, not `transport: "stdio"`
  // https://code.visualstudio.com/docs/agents/reference/mcp-configuration
  it("register entry has VS Code-specific type field and no transport field", async () => {
    await registrar.register("/usr/local/bin/project-brain");

    const configPath = join(tempDir, "mcp.json");
    const config = JSON.parse(await Bun.file(configPath).text());
    const entry = config.servers["project-brain"];

    expect(entry.type).toBe("stdio");
    expect(entry.transport).toBeUndefined();
  });

  it("register preserves pre-existing unrelated mcp.json keys", async () => {
    const configPath = join(tempDir, "mcp.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        inputs: [{ id: "api-key", type: "promptString" }],
        servers: { other: { command: "bar", args: [] } },
      })
    );

    await registrar.register("/usr/local/bin/project-brain");

    const config = JSON.parse(await Bun.file(configPath).text());
    expect(config.inputs).toBeDefined();
    expect(config.servers.other).toBeDefined();
    expect(config.servers["project-brain"]).toBeDefined();
  });

  it("writeRules is a no-op (VS Code has no rules directory)", async () => {
    await expect(registrar.writeRules("irrelevant")).resolves.toBeUndefined();
  });
});
