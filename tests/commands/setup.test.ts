import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { UnparseableConfigError } from "../../src/registrars/json-config.js";
import type { AIToolRegistrar } from "../../src/registrars/types.js";

describe("setup command", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "setup-cmd-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exports execute function", async () => {
    const { execute } = await import("../../src/commands/setup.js");
    expect(typeof execute).toBe("function");
  });

  it("creates data directory", async () => {
    // We need to import the actual implementation
    const { runSetup } = await import("../../src/commands/setup.js");
    const dataDir = join(tempDir, "data");

    const result = await runSetup({
      dataDir,
      skipOllama: true,
      skipRegistration: true,
    });

    expect(result.dataDir).toBe(dataDir);
    // Directory should exist
    const proc = Bun.spawn(["test", "-d", dataDir], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await proc.exited).toBe(0);
  });

  it("skips gracefully if data dir exists", async () => {
    const { runSetup } = await import("../../src/commands/setup.js");
    const dataDir = join(tempDir, "data");
    await Bun.spawn(["mkdir", "-p", dataDir], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;

    const result = await runSetup({
      dataDir,
      skipOllama: true,
      skipRegistration: true,
    });

    expect(result.dataDir).toBe(dataDir);
  });

  it("returns environment info", async () => {
    const { runSetup } = await import("../../src/commands/setup.js");
    const dataDir = join(tempDir, "data");

    const result = await runSetup({
      dataDir,
      skipOllama: true,
      skipRegistration: true,
    });

    expect(result.env).toBeDefined();
    expect(result.env.bun).toBe(Bun.version);
    expect(result.env.platform).toBe(process.platform);
  });

  it("is idempotent on re-run", async () => {
    const { runSetup } = await import("../../src/commands/setup.js");
    const dataDir = join(tempDir, "data");

    await runSetup({ dataDir, skipOllama: true, skipRegistration: true });
    const result = await runSetup({
      dataDir,
      skipOllama: true,
      skipRegistration: true,
    });

    expect(result.dataDir).toBe(dataDir);
  });

  it("degrades gracefully when one registrar throws UnparseableConfigError: others still register", async () => {
    const { runSetup } = await import("../../src/commands/setup.js");
    const dataDir = join(tempDir, "data");

    const badRegistrar: AIToolRegistrar = {
      name: "Zed",
      isInstalled: async () => true,
      register: async () => {
        throw new UnparseableConfigError(
          join(tempDir, "zed-settings.json"),
          new SyntaxError("Unexpected token")
        );
      },
      writeRules: async () => {},
    };

    const goodRegistrar: AIToolRegistrar = {
      name: "Cursor",
      isInstalled: async () => true,
      register: async () => {},
      writeRules: async () => {},
    };

    const result = await runSetup({
      dataDir,
      skipOllama: true,
      registrars: [badRegistrar, goodRegistrar],
      skillInstall: "no",
    });

    expect(result.registeredTools).toEqual(["Cursor"]);
  });

  it("reports manual-instructions for an UnparseableConfigError without throwing out of runSetup", async () => {
    const { runSetup } = await import("../../src/commands/setup.js");
    const dataDir = join(tempDir, "data");
    const badConfigPath = join(tempDir, "zed-settings.json");

    const badRegistrar: AIToolRegistrar = {
      name: "Zed",
      isInstalled: async () => true,
      register: async () => {
        throw new UnparseableConfigError(
          badConfigPath,
          new SyntaxError("Unexpected token")
        );
      },
      writeRules: async () => {},
    };

    const result = await runSetup({
      dataDir,
      skipOllama: true,
      registrars: [badRegistrar],
      skillInstall: "no",
    });

    expect(result.registeredTools).toEqual([]);
    expect(result.manualInstructions).toHaveLength(1);
    expect(result.manualInstructions[0]).toContain("Zed");
    expect(result.manualInstructions[0]).toContain(badConfigPath);
    expect(result.manualInstructions[0]).toContain("JSONC");
    expect(result.manualInstructions[0]).toContain("command");
    expect(result.manualInstructions[0]).toContain("stdio");
  });

  describe("model-routing opt-in", () => {
    function makeFakeClaudeRegistrar() {
      let hasSection = false;
      const calls = { hasModelRouting: 0, writeModelRouting: 0 };
      const registrar: AIToolRegistrar & {
        calls: typeof calls;
        setHasSection(v: boolean): void;
      } = {
        name: "Claude Code",
        isInstalled: async () => true,
        register: async () => {},
        writeRules: async () => {},
        hasModelRouting: async () => {
          calls.hasModelRouting++;
          return hasSection;
        },
        writeModelRouting: async () => {
          calls.writeModelRouting++;
          hasSection = true;
        },
        calls,
        setHasSection: (v: boolean) => {
          hasSection = v;
        },
      };
      return registrar;
    }

    it('modelRouting: "no" never calls hasModelRouting or writeModelRouting', async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const dataDir = join(tempDir, "data");
      const fake = makeFakeClaudeRegistrar();

      await runSetup({
        dataDir,
        skipOllama: true,
        registrars: [fake],
        skillInstall: "no",
        modelRouting: "no",
      });

      expect(fake.calls.hasModelRouting).toBe(0);
      expect(fake.calls.writeModelRouting).toBe(0);
    });

    it('modelRouting: "yes" calls writeModelRouting without calling promptModelRouting', async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const dataDir = join(tempDir, "data");
      const fake = makeFakeClaudeRegistrar();
      let promptCalled = false;

      await runSetup({
        dataDir,
        skipOllama: true,
        registrars: [fake],
        skillInstall: "no",
        modelRouting: "yes",
        promptModelRouting: async () => {
          promptCalled = true;
          return true;
        },
      });

      expect(fake.calls.writeModelRouting).toBe(1);
      expect(promptCalled).toBe(false);
    });

    it('modelRouting: "ask" with hasModelRouting resolving true skips prompting entirely', async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const dataDir = join(tempDir, "data");
      const fake = makeFakeClaudeRegistrar();
      fake.setHasSection(true);
      let promptCalled = false;

      await runSetup({
        dataDir,
        skipOllama: true,
        registrars: [fake],
        skillInstall: "no",
        modelRouting: "ask",
        promptModelRouting: async () => {
          promptCalled = true;
          return true;
        },
      });

      expect(fake.calls.hasModelRouting).toBe(1);
      expect(promptCalled).toBe(false);
      expect(fake.calls.writeModelRouting).toBe(0);
    });

    it('modelRouting: "ask" with hasModelRouting resolving false calls the injected promptModelRouting, and writeModelRouting only if it resolves true', async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const dataDir = join(tempDir, "data");

      const declineFake = makeFakeClaudeRegistrar();
      let declinePromptCalled = false;
      await runSetup({
        dataDir: join(tempDir, "decline"),
        skipOllama: true,
        registrars: [declineFake],
        skillInstall: "no",
        modelRouting: "ask",
        promptModelRouting: async () => {
          declinePromptCalled = true;
          return false;
        },
      });
      expect(declinePromptCalled).toBe(true);
      expect(declineFake.calls.writeModelRouting).toBe(0);

      const acceptFake = makeFakeClaudeRegistrar();
      let acceptPromptCalled = false;
      await runSetup({
        dataDir: join(tempDir, "accept"),
        skipOllama: true,
        registrars: [acceptFake],
        skillInstall: "no",
        modelRouting: "ask",
        promptModelRouting: async () => {
          acceptPromptCalled = true;
          return true;
        },
      });
      expect(acceptPromptCalled).toBe(true);
      expect(acceptFake.calls.writeModelRouting).toBe(1);
    });

    it("registrars without hasModelRouting/writeModelRouting (non-Claude) are skipped without error", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const dataDir = join(tempDir, "data");

      const plainRegistrar: AIToolRegistrar = {
        name: "Codex",
        isInstalled: async () => true,
        register: async () => {},
        writeRules: async () => {},
      };

      const result = await runSetup({
        dataDir,
        skipOllama: true,
        registrars: [plainRegistrar],
        skillInstall: "no",
        modelRouting: "yes",
      });

      expect(result.registeredTools).toEqual(["Codex"]);
    });
  });

  /**
   * brain-audit skill install.
   *
   * Every test here MUST pass skillTargetDirs. Without it the real
   * getSkillTargetDirs(registeredTools) resolves against homedir() and the
   * suite writes brain-audit into the developer's actual ~/.claude/skills.
   * That is not hypothetical — the project registry did exactly this and
   * polluted a real home directory with ~180 entries.
   */
  describe("brain-audit skill install", () => {
    function makeInstalledRegistrar(name: string): AIToolRegistrar {
      return {
        name,
        isInstalled: async () => true,
        register: async () => {},
        writeRules: async () => {},
      };
    }

    it('skillInstall: "yes" installs without prompting', async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      let prompted = false;

      const result = await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        registrars: [makeInstalledRegistrar("Claude Code")],
        modelRouting: "no",
        skillInstall: "yes",
        skillTargetDirs: [join(tempDir, "skills")],
        promptSkillInstall: async () => {
          prompted = true;
          return true;
        },
      });

      expect(prompted).toBe(false);
      expect(result.skillTargets).toEqual([join(tempDir, "skills", "brain-audit")]);
      expect(result.skillSkipped).toEqual([]);

      const skillMd = await readFile(
        join(tempDir, "skills", "brain-audit", "SKILL.md"),
        "utf8"
      );
      expect(skillMd).toContain("name: brain-audit");
    });

    it('skillInstall: "no" skips entirely', async () => {
      const { runSetup } = await import("../../src/commands/setup.js");

      const result = await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        registrars: [makeInstalledRegistrar("Claude Code")],
        modelRouting: "no",
        skillInstall: "no",
        skillTargetDirs: [join(tempDir, "skills")],
      });

      expect(result.skillTargets).toEqual([]);
      expect(existsSync(join(tempDir, "skills", "brain-audit"))).toBe(false);
    });

    it('skillInstall: "ask" defers to promptSkillInstall — declining writes nothing', async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      let prompted = false;

      const result = await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        registrars: [makeInstalledRegistrar("Claude Code")],
        modelRouting: "no",
        skillInstall: "ask",
        skillTargetDirs: [join(tempDir, "skills")],
        promptSkillInstall: async () => {
          prompted = true;
          return false;
        },
      });

      expect(prompted).toBe(true);
      expect(result.skillTargets).toEqual([]);
      expect(existsSync(join(tempDir, "skills", "brain-audit"))).toBe(false);
    });

    it("reports no targets when no tools were registered", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");

      const result = await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        skipRegistration: true,
        skillInstall: "yes",
      });

      expect(result.registeredTools).toEqual([]);
      expect(result.skillTargets).toEqual([]);
    });

    /** Design §7: a hand-written brain-audit/ is left alone and setup still succeeds. */
    it("warns and continues when the target is foreign, leaving it untouched", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const skillsRoot = join(tempDir, "skills");
      const skillDir = join(skillsRoot, "brain-audit");
      await mkdir(skillDir, { recursive: true });
      const mine = "---\nname: brain-audit\n---\nhand-written, do not touch\n";
      await writeFile(join(skillDir, "SKILL.md"), mine);

      const result = await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        registrars: [makeInstalledRegistrar("Claude Code")],
        modelRouting: "no",
        skillInstall: "yes",
        skillTargetDirs: [skillsRoot],
      });

      expect(result.skillTargets).toEqual([]);
      expect(result.skillSkipped).toEqual([{ dir: skillDir, reason: "foreign" }]);
      expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(mine);
    });
  });
});
