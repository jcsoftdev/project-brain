import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ClaudeRegistrar } from "../../src/registrars/claude.js";

describe("ClaudeRegistrar", () => {
  let registrar: ClaudeRegistrar;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-reg-"));
    registrar = new ClaudeRegistrar(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("has name 'Claude Code'", () => {
    expect(registrar.name).toBe("Claude Code");
  });

  it("isInstalled returns boolean based on Bun.which", async () => {
    const result = await registrar.isInstalled();
    expect(typeof result).toBe("boolean");
  });

  it("register creates .claude.json (home root) with MCP entry on CLI failure", async () => {
    // Inject a CLI runner that always fails, forcing the JSON fallback
    // deterministically without spawning the real claude binary.
    // The fallback must land at the HOME ROOT dotfile (~/.claude.json), the
    // file Claude Code's `mcp add --scope user` actually reads — NOT under
    // baseDir (~/.claude/), which Claude Code never reads for MCP config.
    // homeDir is injected via the 3rd constructor param to keep this
    // deterministic/offline.
    registrar = new ClaudeRegistrar(tempDir, async () => false, tempDir);
    await registrar.register("/usr/local/bin/project-brain");

    const configPath = join(tempDir, ".claude.json");
    const config = JSON.parse(await Bun.file(configPath).text());

    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers["project-brain"]).toBeDefined();
    expect(config.mcpServers["project-brain"].command).toBe("bun");
    expect(config.mcpServers["project-brain"].args).toContain(
      "/usr/local/bin/project-brain"
    );
  });

  it("register preserves existing JSON keys in fallback", async () => {
    // Force the fallback path so the assertion is deterministic.
    registrar = new ClaudeRegistrar(tempDir, async () => false, tempDir);
    const configPath = join(tempDir, ".claude.json");
    await Bun.write(
      configPath,
      JSON.stringify({ mcpServers: { other: { command: "other" } } })
    );

    await registrar.register("/usr/local/bin/project-brain");

    const config = JSON.parse(await Bun.file(configPath).text());
    expect(config.mcpServers.other).toBeDefined();
    expect(config.mcpServers["project-brain"]).toBeDefined();
  });

  it("writeRules writes to CLAUDE.md using section markers", async () => {
    await registrar.writeRules("Use project-brain for context.");

    const rulesPath = join(tempDir, "CLAUDE.md");
    const content = await Bun.file(rulesPath).text();

    expect(content).toContain("<!-- project-brain:start -->");
    expect(content).toContain("Use project-brain for context.");
    expect(content).toContain("<!-- project-brain:end -->");
  });

  describe("model routing section", () => {
    it("hasModelRouting returns false before writeModelRouting is called", async () => {
      expect(await registrar.hasModelRouting?.()).toBe(false);
    });

    it("writeModelRouting writes to CLAUDE.md under the project-brain-model-routing marker", async () => {
      await registrar.writeModelRouting?.("Route sub-agents by task type.");

      const rulesPath = join(tempDir, "CLAUDE.md");
      const content = await Bun.file(rulesPath).text();

      expect(content).toContain("<!-- project-brain-model-routing:start -->");
      expect(content).toContain("Route sub-agents by task type.");
      expect(content).toContain("<!-- project-brain-model-routing:end -->");
    });

    it("hasModelRouting returns true after writeModelRouting is called (round-trip)", async () => {
      await registrar.writeModelRouting?.("Route sub-agents by task type.");
      expect(await registrar.hasModelRouting?.()).toBe(true);
    });

    it("writeModelRouting does not clobber a pre-existing writeRules section", async () => {
      await registrar.writeRules("Use project-brain for context.");
      await registrar.writeModelRouting?.("Route sub-agents by task type.");

      const rulesPath = join(tempDir, "CLAUDE.md");
      const content = await Bun.file(rulesPath).text();

      expect(content).toContain("Use project-brain for context.");
      expect(content).toContain("Route sub-agents by task type.");
    });
  });
});
