import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { UnparseableConfigError } from "../../src/registrars/json-config.js";
import type { AIToolRegistrar } from "../../src/registrars/types.js";
import { SKILL_MANIFESTS } from "../../src/rules/skills.js";
import { ROUTING_CONTENT_VERSION } from "../../src/constants.js";

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

  /**
   * Skills are markdown a host reads on its own — no MCP server behind them.
   * Deriving their targets from registeredTools welded two unrelated failures
   * together: one unparseable config file silently cost the user every skill
   * for that tool, with nothing in the output to explain it.
   */
  describe("skill targets follow installed, not registered", () => {
    const failing: AIToolRegistrar = {
      name: "Zed",
      isInstalled: async () => true,
      register: async () => {
        throw new Error("config is a mess");
      },
      writeRules: async () => {},
    };

    it("records a detected tool in installedTools even when registration fails", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const result = await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        registrars: [failing],
        skillInstall: "no",
      });

      expect(result.registeredTools).toEqual([]);
      expect(result.installedTools).toEqual(["Zed"]);
    });

    it("still installs skills for a tool whose registration failed", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const skillRoot = join(tempDir, "skills-root");

      const result = await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        registrars: [failing],
        skillInstall: "yes",
        skillTargetDirs: [skillRoot],
      });

      expect(result.registeredTools).toEqual([]);
      expect(result.skillTargets.length).toBeGreaterThan(0);
      expect(existsSync(join(skillRoot, "brain-commit", "SKILL.md"))).toBe(true);
    });

    it("leaves installedTools empty when nothing is detected", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const absent: AIToolRegistrar = {
        name: "Cursor",
        isInstalled: async () => false,
        register: async () => {},
        writeRules: async () => {},
      };

      const result = await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        registrars: [absent],
        skillInstall: "no",
      });

      expect(result.installedTools).toEqual([]);
    });
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

  describe("model-routing", () => {
    /**
     * A registrar that carries a routing descriptor and remembers what version
     * it has "written", so version transitions can be driven from a test.
     */
    function makeRoutingRegistrar(name = "Claude Code", version: number | null = null) {
      const calls = { writtenRoutingVersion: 0, writeModelRouting: 0 };
      let written: number | null = version;

      const registrar: AIToolRegistrar & {
        calls: typeof calls;
        lastContent: string | null;
      } = {
        name,
        isInstalled: async () => true,
        register: async () => {},
        writeRules: async () => {},
        routing: {
          hostKey: "claude",
          mechanism: "per-spawn",
          howToApply: "pass `model` on the call.",
          labelField: "the description field",
          models: { fast: "haiku", balanced: "sonnet", deep: "opus" },
        },
        writtenRoutingVersion: async () => {
          calls.writtenRoutingVersion++;
          return written;
        },
        writeModelRouting: async (content: string) => {
          calls.writeModelRouting++;
          registrar.lastContent = content;
          written = ROUTING_CONTENT_VERSION;
        },
        calls,
        lastContent: null,
      };
      return registrar;
    }

    it('"no" touches nothing — not even the version check', async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const fake = makeRoutingRegistrar();

      await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        registrars: [fake],
        skillInstall: "no",
        modelRouting: "no",
      });

      expect(fake.calls.writtenRoutingVersion).toBe(0);
      expect(fake.calls.writeModelRouting).toBe(0);
    });

    it('"yes" writes without prompting', async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const fake = makeRoutingRegistrar();
      let promptCalled = false;

      await runSetup({
        dataDir: join(tempDir, "data"),
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

    it('"ask" with nothing written prompts, and writes only on acceptance', async () => {
      const { runSetup } = await import("../../src/commands/setup.js");

      const declined = makeRoutingRegistrar();
      await runSetup({
        dataDir: join(tempDir, "decline"),
        skipOllama: true,
        registrars: [declined],
        skillInstall: "no",
        modelRouting: "ask",
        promptModelRouting: async () => false,
      });
      expect(declined.calls.writeModelRouting).toBe(0);

      const accepted = makeRoutingRegistrar();
      await runSetup({
        dataDir: join(tempDir, "accept"),
        skipOllama: true,
        registrars: [accepted],
        skillInstall: "no",
        modelRouting: "ask",
        promptModelRouting: async () => true,
      });
      expect(accepted.calls.writeModelRouting).toBe(1);
    });

    it("rewrites a stale section WITHOUT asking again", async () => {
      // The user already consented to having this section. Re-asking on every
      // content update would train them to say no.
      const { runSetup } = await import("../../src/commands/setup.js");
      const stale = makeRoutingRegistrar("Claude Code", 1);
      let promptCalled = false;

      await runSetup({
        dataDir: join(tempDir, "stale"),
        skipOllama: true,
        registrars: [stale],
        skillInstall: "no",
        modelRouting: "ask",
        promptModelRouting: async () => {
          promptCalled = true;
          return true;
        },
      });

      expect(stale.calls.writeModelRouting).toBe(1);
      expect(promptCalled).toBe(false);
    });

    it("leaves a current section alone", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const current = makeRoutingRegistrar("Claude Code", ROUTING_CONTENT_VERSION);
      let promptCalled = false;

      await runSetup({
        dataDir: join(tempDir, "current"),
        skipOllama: true,
        registrars: [current],
        skillInstall: "no",
        modelRouting: "ask",
        promptModelRouting: async () => {
          promptCalled = true;
          return true;
        },
      });

      expect(current.calls.writeModelRouting).toBe(0);
      expect(promptCalled).toBe(false);
    });

    it("writes host-specific content, not one shared blob", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const fake = makeRoutingRegistrar();

      await runSetup({
        dataDir: join(tempDir, "content"),
        skipOllama: true,
        registrars: [fake],
        skillInstall: "no",
        modelRouting: "yes",
      });

      expect(fake.lastContent).toContain("Claude Code");
      expect(fake.lastContent).toContain("haiku");
      expect(fake.lastContent).toContain(`model-routing-version: ${ROUTING_CONTENT_VERSION}`);
    });

    it("skips a registrar with no routing descriptor without error", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");

      const plainRegistrar: AIToolRegistrar = {
        name: "Zed",
        isInstalled: async () => true,
        register: async () => {},
        writeRules: async () => {},
      };

      const result = await runSetup({
        dataDir: join(tempDir, "plain"),
        skipOllama: true,
        registrars: [plainRegistrar],
        skillInstall: "no",
        modelRouting: "yes",
      });

      expect(result.registeredTools).toEqual(["Zed"]);
    });

    it("one host throwing does not rob the others of their section", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const broken = makeRoutingRegistrar("Codex");
      broken.writeModelRouting = async () => {
        throw new Error("disk on fire");
      };
      const healthy = makeRoutingRegistrar("Claude Code");

      await runSetup({
        dataDir: join(tempDir, "partial"),
        skipOllama: true,
        registrars: [broken, healthy],
        skillInstall: "no",
        modelRouting: "yes",
      });

      expect(healthy.calls.writeModelRouting).toBe(1);
    });

    describe("routing hooks", () => {
      async function runWithHooks(
        routingHook: { mode: "ask" | "yes" | "no"; strict: boolean },
        extra: Record<string, unknown> = {}
      ) {
        const { runSetup } = await import("../../src/commands/setup.js");
        const dir = await mkdtemp(join(tmpdir(), "pb-hooks-"));
        const settingsPath = join(dir, "settings.json");

        const result = await runSetup({
          dataDir: join(dir, "data"),
          skipOllama: true,
          registrars: [makeRoutingRegistrar()],
          skillInstall: "no",
          modelRouting: "yes",
          routingHook,
          claudeSettingsPath: settingsPath,
          ...extra,
        });

        const written = existsSync(settingsPath)
          ? JSON.parse(await readFile(settingsPath, "utf8"))
          : null;
        return { result, written, settingsPath };
      }

      it('writes nothing on "no"', async () => {
        const { result, written } = await runWithHooks({ mode: "no", strict: false });
        expect(result.routingHooks).toEqual({ installed: false, strict: false });
        expect(written).toBeNull();
      });

      it("installs the SessionStart reminder without the guard by default", async () => {
        const { result, written } = await runWithHooks({ mode: "yes", strict: false });

        expect(result.routingHooks).toEqual({ installed: true, strict: false });
        expect(JSON.stringify(written.hooks.SessionStart)).toContain("routing-rules");
        expect(written.hooks.PreToolUse).toBeUndefined();
      });

      it("adds the guard in strict mode", async () => {
        const { result, written } = await runWithHooks({ mode: "yes", strict: true });

        expect(result.routingHooks.strict).toBe(true);
        expect(JSON.stringify(written.hooks.PreToolUse)).toContain("routing-guard");
      });

      it("rides on the routing answer when no flag was given", async () => {
        // Declining the guidance and then being reminded of it every session
        // would be the worst of both.
        const { result, written } = await runWithHooks(
          { mode: "ask", strict: false },
          { modelRouting: "ask", promptModelRouting: async () => false }
        );

        expect(result.routingHooks.installed).toBe(false);
        expect(written).toBeNull();
      });

      it("refuses to touch a settings.json it cannot parse", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pb-hooks-bad-"));
        const settingsPath = join(dir, "settings.json");
        await writeFile(settingsPath, "{ definitely not json");

        const { runSetup } = await import("../../src/commands/setup.js");
        const result = await runSetup({
          dataDir: join(dir, "data"),
          skipOllama: true,
          registrars: [makeRoutingRegistrar()],
          skillInstall: "no",
          modelRouting: "yes",
          routingHook: { mode: "yes", strict: false },
          claudeSettingsPath: settingsPath,
        });

        expect(result.routingHooks.installed).toBe(false);
        // Hand-written content survives — we do not "repair" what we cannot read.
        expect(await readFile(settingsPath, "utf8")).toBe("{ definitely not json");
      });
    });

    it("asks once, then applies the answer to every eligible host", async () => {
      // Six prompts for one decision is six chances to say no by accident.
      const { runSetup } = await import("../../src/commands/setup.js");
      const a = makeRoutingRegistrar("Claude Code");
      const b = makeRoutingRegistrar("Codex");
      let prompts = 0;

      await runSetup({
        dataDir: join(tempDir, "once"),
        skipOllama: true,
        registrars: [a, b],
        skillInstall: "no",
        modelRouting: "ask",
        promptModelRouting: async () => {
          prompts++;
          return true;
        },
      });

      expect(prompts).toBe(1);
      expect(a.calls.writeModelRouting).toBe(1);
      expect(b.calls.writeModelRouting).toBe(1);
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
   *
   * And do NOT reach for a scratch $HOME instead. Bun caches os.homedir() on
   * its first call, so redirecting HOME afterwards is silently ignored:
   *
   *   const before = homedir();        // primes the cache with the real home
   *   process.env.HOME = scratch;
   *   homedir() === before             // true — isolation lost, no error
   *
   * An end-to-end run of runSetup written that way wrote into three real home
   * directories while reporting success. Injection is the only sound seam here.
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
      expect(result.skillSkipped).toEqual([]);
      // Every registered skill lands, not just the first one.
      expect(result.skillTargets.sort()).toEqual(
        Object.keys(SKILL_MANIFESTS)
          .map((name) => join(tempDir, "skills", name))
          .sort()
      );

      for (const name of Object.keys(SKILL_MANIFESTS)) {
        const skillMd = await readFile(join(tempDir, "skills", name, "SKILL.md"), "utf8");
        expect(skillMd, name).toContain(`name: ${name}`);
      }
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

      expect(result.skillSkipped).toEqual([{ dir: skillDir, reason: "foreign" }]);
      expect(result.skillTargets).not.toContain(skillDir);
      expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(mine);
      // Setup still completed: the other skills installed beside the foreign one.
      expect(result.skillTargets.length).toBe(Object.keys(SKILL_MANIFESTS).length - 1);
    });
  });
});
