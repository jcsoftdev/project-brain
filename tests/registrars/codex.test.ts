import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { CodexRegistrar } from "../../src/registrars/codex.js";

describe("CodexRegistrar", () => {
  let registrar: CodexRegistrar;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codex-reg-"));
    registrar = new CodexRegistrar(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("has name 'Codex'", () => {
    expect(registrar.name).toBe("Codex");
  });

  it("isInstalled returns boolean based on Bun.which", async () => {
    const result = await registrar.isInstalled();
    expect(typeof result).toBe("boolean");
  });

  it("register attempts CLI spawn (may fail gracefully)", async () => {
    // In test env, codex likely not installed — should not throw
    await expect(
      registrar.register("/usr/local/bin/project-brain")
    ).resolves.toBeUndefined();
  });

  it("writeRules writes to instructions.md using section markers", async () => {
    await registrar.writeRules("Use project-brain MCP tools.");

    const rulesPath = join(tempDir, "instructions.md");
    const content = await Bun.file(rulesPath).text();

    expect(content).toContain("<!-- project-brain:start -->");
    expect(content).toContain("Use project-brain MCP tools.");
    expect(content).toContain("<!-- project-brain:end -->");
  });
});
