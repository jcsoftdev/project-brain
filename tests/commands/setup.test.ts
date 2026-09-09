import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { UnparseableConfigError } from "../../src/registrars/json-config.js";
import type { AIToolRegistrar } from "../../src/registrars/types.js";
import { SKILL_MANIFESTS } from "../../src/rules/skills.js";
import { ROUTING_CONTENT_VERSION } from "../../src/constants.js";

describe("setup command", () => {
  // The settings path is redirected for the whole file: the hook installers
  // resolve it at CALL time, and 27 of the runSetup calls below inject no
  // explicit path. Without this the suite WRITES INTO THE DEVELOPER'S REAL
  // settings.json — observed once, on a full `bun test` run.
  //
  // Redirected via BRAIN_CLAUDE_SETTINGS and NOT via HOME, because Bun's
  // os.homedir() ignores a runtime HOME change while node's honours it, so a
  // HOME override here would look like a guard and protect nothing.
  let homeBackup: string | undefined;
  let fakeHome: string;
  beforeAll(async () => {
    homeBackup = process.env.BRAIN_CLAUDE_SETTINGS;
    fakeHome = await mkdtemp(join(tmpdir(), "pb-fake-home-"));
    process.env.BRAIN_CLAUDE_SETTINGS = join(fakeHome, "settings.json");
  });
  afterAll(async () => {
    if (homeBackup === undefined) delete process.env.BRAIN_CLAUDE_SETTINGS;
    else process.env.BRAIN_CLAUDE_SETTINGS = homeBackup;
    await rm(fakeHome, { recursive: true, force: true });
  });

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
      skillTargetDirs: [],
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
        skillTargetDirs: [],
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
        skillTargetDirs: [],
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
      skillTargetDirs: [],
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

    // Task 11 note: `modelRouting`/`promptModelRouting` are gone — the
    // per-decision prompts they drove were replaced by ONE unit checklist
    // (`promptUnitSelection`) covering "guidance:model-routing" among every
    // other unit. Below, explicit `units` selection stands in for the old
    // "yes"/"no" flags (and proves no prompt happens), and a
    // `promptUnitSelection` mock stands in for the old "ask" + per-option
    // prompt.

    it("excluding guidance:model-routing writes nothing (inspect still reads the version)", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const fake = makeRoutingRegistrar();

      await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        registrars: [fake],
        skillTargetDirs: [],
        units: { mode: "explicit", selected: [] },
      });

      // Task 11 inspects every unit BEFORE consent, so the checklist can show
      // an accurate state regardless of the final choice — the cheap version
      // read always happens now; it is the WRITE that is gated on selection.
      expect(fake.calls.writtenRoutingVersion).toBe(1);
      expect(fake.calls.writeModelRouting).toBe(0);
    });

    it("an explicit selection writes without prompting", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const fake = makeRoutingRegistrar();
      let promptCalled = false;

      await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        registrars: [fake],
        skillTargetDirs: [],
        units: { mode: "explicit", selected: ["guidance:model-routing"] },
        promptUnitSelection: async () => {
          promptCalled = true;
          return [];
        },
      });

      expect(fake.calls.writeModelRouting).toBe(1);
      expect(promptCalled).toBe(false);
    });

    it("with no explicit selection, the checklist is asked, and writes only when chosen", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");

      const declined = makeRoutingRegistrar();
      await runSetup({
        dataDir: join(tempDir, "decline"),
        skipOllama: true,
        registrars: [declined],
        skillTargetDirs: [],
        promptUnitSelection: async (rows) =>
          rows.filter((r) => r.id !== "guidance:model-routing").map((r) => r.id),
      });
      expect(declined.calls.writeModelRouting).toBe(0);

      const accepted = makeRoutingRegistrar();
      await runSetup({
        dataDir: join(tempDir, "accept"),
        skipOllama: true,
        registrars: [accepted],
        skillTargetDirs: [],
        promptUnitSelection: async (rows) => rows.map((r) => r.id),
      });
      expect(accepted.calls.writeModelRouting).toBe(1);
    });

    it("a stale section rewrites under the default (non-interactive) selection", async () => {
      // The user already consented to having this section. The default
      // resolution pre-ticks a stale unit (see `initialChecked`), so a
      // non-interactive run rewrites it without a fresh prompt.
      const { runSetup } = await import("../../src/commands/setup.js");
      const stale = makeRoutingRegistrar("Claude Code", 1);
      let sawChosen: boolean | undefined;

      await runSetup({
        dataDir: join(tempDir, "stale"),
        skipOllama: true,
        registrars: [stale],
        skillTargetDirs: [],
        // Stands in for the old promptCalled assertion: capture what the
        // checklist row looked like when it arrived, instead of asserting a
        // prompt call never happened (one always does now — see the note
        // above the excluding-guidance-writes-nothing test). "Pre-ticked, not
        // re-asked" is exactly `chosen === true` on arrival.
        promptUnitSelection: async (rows) => {
          sawChosen = rows.find((r) => r.id === "guidance:model-routing")?.chosen;
          return rows.filter((r) => r.chosen).map((r) => r.id);
        },
      });

      expect(stale.calls.writeModelRouting).toBe(1);
      expect(sawChosen).toBe(true);
    });

    it("leaves a current section alone", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const current = makeRoutingRegistrar("Claude Code", ROUTING_CONTENT_VERSION);
      let sawChosen: boolean | undefined;

      await runSetup({
        dataDir: join(tempDir, "current"),
        skipOllama: true,
        registrars: [current],
        skillTargetDirs: [],
        promptUnitSelection: async (rows) => {
          sawChosen = rows.find((r) => r.id === "guidance:model-routing")?.chosen;
          return rows.filter((r) => r.chosen).map((r) => r.id);
        },
      });

      expect(current.calls.writeModelRouting).toBe(0);
      expect(sawChosen).toBe(true);
    });

    it("writes host-specific content, not one shared blob", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const fake = makeRoutingRegistrar();

      await runSetup({
        dataDir: join(tempDir, "content"),
        skipOllama: true,
        registrars: [fake],
        skillTargetDirs: [],
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
        skillTargetDirs: [],
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
        skillTargetDirs: [],
      });

      expect(healthy.calls.writeModelRouting).toBe(1);
    });

    describe("routing hooks", () => {
      async function runWithHooks(unitIds: string[], extra: Record<string, unknown> = {}) {
        const { runSetup } = await import("../../src/commands/setup.js");
        const dir = await mkdtemp(join(tmpdir(), "pb-hooks-"));
        const settingsPath = join(dir, "settings.json");

        const result = await runSetup({
          dataDir: join(dir, "data"),
          skipOllama: true,
          registrars: [makeRoutingRegistrar()],
          skillTargetDirs: [],
          units: { mode: "explicit", selected: unitIds },
          claudeSettingsPath: settingsPath,
          ...extra,
        });

        const written = existsSync(settingsPath)
          ? JSON.parse(await readFile(settingsPath, "utf8"))
          : null;
        return { result, written, settingsPath };
      }

      it("writes no routing hook when hooks:routing is not selected", async () => {
        // This call selects only "guidance:model-routing" — "hooks:worktree" is
        // also not selected here, so the settings file is never created at all
        // (`written` resolves to null via the `existsSync` guard). Selecting
        // "hooks:worktree" without "hooks:routing" would still create the file
        // and write only the worktree hooks into it — index hygiene installs on
        // its own selection, independent of the routing preference.
        const { result, written } = await runWithHooks(["guidance:model-routing"]);
        expect(result.routingHooks).toEqual({ installed: false, strict: false });
        expect(JSON.stringify(written ?? {})).not.toContain("routing-rules");
        expect(JSON.stringify(written ?? {})).not.toContain("routing-guard");
      });

      it("installs the SessionStart reminder without the guard by default", async () => {
        const { result, written } = await runWithHooks(["hooks:routing"]);

        expect(result.routingHooks).toEqual({ installed: true, strict: false });
        expect(JSON.stringify(written.hooks.SessionStart)).toContain("routing-rules");
        expect(written.hooks.PreToolUse).toBeUndefined();
      });

      it("adds the guard in strict mode", async () => {
        const { result, written } = await runWithHooks(["hooks:routing"], {
          routingHook: { strict: true },
        });

        expect(result.routingHooks.strict).toBe(true);
        expect(JSON.stringify(written.hooks.PreToolUse)).toContain("routing-guard");
      });

      it("is independent of the model-routing guidance selection", async () => {
        // Earlier behaviour let the hooks ride on the model-routing answer.
        // src/setup/units.ts now says explicitly (see guidanceUnits' doc
        // comment) that the guidance and the two hook pairs are three
        // separate choices — declining the guidance no longer implies
        // declining its reminder hook.
        const { result, written } = await runWithHooks(["hooks:routing"]);

        expect(result.routingHooks.installed).toBe(true);
        expect(JSON.stringify(written.hooks.SessionStart)).toContain("routing-rules");
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
          skillTargetDirs: [],
          units: { mode: "explicit", selected: ["hooks:routing"] },
          claudeSettingsPath: settingsPath,
        });

        expect(result.routingHooks.installed).toBe(false);
        // Hand-written content survives — we do not "repair" what we cannot read.
        expect(await readFile(settingsPath, "utf8")).toBe("{ definitely not json");
      });
    });

    it("prompts once, and the checklist answer applies to every eligible host", async () => {
      // Six prompts for one decision is six chances to say no by accident.
      const { runSetup } = await import("../../src/commands/setup.js");
      const a = makeRoutingRegistrar("Claude Code");
      const b = makeRoutingRegistrar("Codex");
      let prompts = 0;

      await runSetup({
        dataDir: join(tempDir, "once"),
        skipOllama: true,
        registrars: [a, b],
        skillTargetDirs: [],
        promptUnitSelection: async (rows) => {
          prompts++;
          return rows.map((r) => r.id);
        },
      });

      expect(prompts).toBe(1);
      expect(a.calls.writeModelRouting).toBe(1);
      expect(b.calls.writeModelRouting).toBe(1);
    });
  });

  /**
   * Bundled-skill install, via the "Skills" group of setup units.
   *
   * Every test here MUST pass skillTargetDirs. Without it the real
   * getSkillTargetDirs(registeredTools) resolves against homedir() and the
   * suite writes skills into the developer's actual ~/.claude/skills.
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
  describe("bundled skill install", () => {
    function makeInstalledRegistrar(name: string): AIToolRegistrar {
      return {
        name,
        isInstalled: async () => true,
        register: async () => {},
        writeRules: async () => {},
      };
    }

    it("installing all skills does not require prompting", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      let prompted = false;
      const skillIds = Object.keys(SKILL_MANIFESTS).map((name) => `skill:${name}`);

      const result = await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        registrars: [makeInstalledRegistrar("Claude Code")],
        skillTargetDirs: [join(tempDir, "skills")],
        units: { mode: "explicit", selected: skillIds },
        promptUnitSelection: async () => {
          prompted = true;
          return [];
        },
      });

      expect(prompted).toBe(false);
      expect(result.skillSkipped).toEqual([]);
      // Every skill lands, not just the first one.
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

    it("declining every skill unit skips installation entirely", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const skillsRoot = join(tempDir, "skills");

      const result = await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        registrars: [makeInstalledRegistrar("Claude Code")],
        skillTargetDirs: [skillsRoot],
        units: { mode: "explicit", selected: ["host:claudecode"] },
      });

      expect(result.skillTargets).toEqual([]);
      expect(existsSync(join(skillsRoot, "brain-audit"))).toBe(false);
    });

    it("declining skills in the checklist prompt writes nothing", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      let prompted = false;
      const skillsRoot = join(tempDir, "skills");

      const result = await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        registrars: [makeInstalledRegistrar("Claude Code")],
        skillTargetDirs: [skillsRoot],
        promptUnitSelection: async (rows) => {
          prompted = true;
          return rows.filter((r) => r.group !== "Skills").map((r) => r.id);
        },
      });

      expect(prompted).toBe(true);
      expect(result.skillTargets).toEqual([]);
      expect(existsSync(join(skillsRoot, "brain-audit"))).toBe(false);
    });

    it("reports no targets when no tools were registered", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");

      const result = await runSetup({
        dataDir: join(tempDir, "data"),
        skipOllama: true,
        skipRegistration: true,
      });

      expect(result.registeredTools).toEqual([]);
      expect(result.skillTargets).toEqual([]);
    });

    /** A hand-written brain-audit/ is left alone and setup still succeeds. */
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
        skillTargetDirs: [skillsRoot],
      });

      expect(result.skillSkipped).toEqual([{ dir: skillDir, reason: "foreign" }]);
      expect(result.skillTargets).not.toContain(skillDir);
      expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(mine);
      // Setup still completed: the other skills installed beside the foreign one.
      expect(result.skillTargets.length).toBe(Object.keys(SKILL_MANIFESTS).length - 1);
    });
  });

  describe("runSetup unit selection", () => {
    it("applies the saved selection without prompting and removes what was declined", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const { saveSelection } = await import("../../src/setup/selection.js");
      const dir = await mkdtemp(join(tmpdir(), "pb-setup-sel-"));
      const selectionPath = join(dir, "setup-selection.json");
      const skillsDir = join(dir, "skills");

      // First run: everything.
      await runSetup({
        dataDir: join(dir, "data"),
        skipOllama: true,
        skipRegistration: true,
        selectionPath,
        skillTargetDirs: [skillsDir],
        claudeSettingsPath: join(dir, "settings.json"),
        recordConfigPath: join(dir, "record-config.json"),
        units: { mode: "explicit", selected: ["skill:brain-audit", "skill:brain-okf"] },
      });
      expect(existsSync(join(skillsDir, "brain-okf"))).toBe(true);

      // Second run: the same call with brain-okf dropped must delete it.
      await runSetup({
        dataDir: join(dir, "data"),
        skipOllama: true,
        skipRegistration: true,
        selectionPath,
        skillTargetDirs: [skillsDir],
        claudeSettingsPath: join(dir, "settings.json"),
        recordConfigPath: join(dir, "record-config.json"),
        units: { mode: "explicit", selected: ["skill:brain-audit"] },
      });

      expect(existsSync(join(skillsDir, "brain-audit"))).toBe(true);
      expect(existsSync(join(skillsDir, "brain-okf"))).toBe(false);

      await rm(dir, { recursive: true, force: true });
    });

    it("writes a selection file recording both what was chosen and what was not", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const { loadSelection } = await import("../../src/setup/selection.js");
      const dir = await mkdtemp(join(tmpdir(), "pb-setup-write-"));
      const selectionPath = join(dir, "setup-selection.json");

      await runSetup({
        dataDir: join(dir, "data"),
        skipOllama: true,
        skipRegistration: true,
        selectionPath,
        skillTargetDirs: [join(dir, "skills")],
        claudeSettingsPath: join(dir, "settings.json"),
        recordConfigPath: join(dir, "record-config.json"),
        units: { mode: "explicit", selected: ["skill:brain-audit"] },
      });

      const saved = await loadSelection(selectionPath);
      expect(saved?.selected).toContain("skill:brain-audit");
      expect(saved?.declined).toContain("skill:brain-okf");

      await rm(dir, { recursive: true, force: true });
    });

    it("keeps a prior install when upgrading into the picker with no selection file", async () => {
      const { runSetup } = await import("../../src/commands/setup.js");
      const { installSkill } = await import("../../src/rules/skills.js");
      const dir = await mkdtemp(join(tmpdir(), "pb-setup-migrate-"));
      const skillsDir = join(dir, "skills");

      // Simulate a machine set up by an older release: skills on disk, no selection file.
      await installSkill([skillsDir]);

      await runSetup({
        dataDir: join(dir, "data"),
        skipOllama: true,
        skipRegistration: true,
        selectionPath: join(dir, "setup-selection.json"),
        skillTargetDirs: [skillsDir],
        claudeSettingsPath: join(dir, "settings.json"),
        recordConfigPath: join(dir, "record-config.json"),
        // No `units` override and no TTY: the defaults path must not delete.
      });

      expect(existsSync(join(skillsDir, "brain-okf"))).toBe(true);
      expect(existsSync(join(skillsDir, "brain-audit"))).toBe(true);

      await rm(dir, { recursive: true, force: true });
    });
  });
});

/**
 * Task 4 fix round 1, finding 1: `installSkill`'s rewrite made `written`
 * skill-major (every root for skill A, then every root for skill B) instead
 * of dir-major. No `InstallResult` test cares about order, but `execute()`'s
 * "Skill installed in:" line printed that array raw — so with two or more
 * skill target roots the CLI output silently went from grouped-by-directory
 * to interleaved-by-skill.
 *
 * `execute()` itself calls the real environment detection, real registrars
 * and real interactive prompts with no injection point, so exercising the
 * actual `console.log` line here would mean either hitting the developer's
 * real ~/.claude and ~/.agents directories or restructuring `execute()`'s
 * signature — out of scope for a display-only fix. `formatSkillTargets` is
 * the display-site fix `execute()` now calls, extracted specifically so this
 * regression has somewhere to be pinned without either of those costs.
 */
describe("formatSkillTargets", () => {
  it("sorts skill-major installer output back into deterministic, grouped-by-directory order", async () => {
    const { formatSkillTargets } = await import("../../src/commands/setup.js");

    // Shape installSkill now produces with 2 skills x 2 target roots: every
    // root for brain-audit, then every root for brain-commit.
    const skillMajor = [
      join("/roots/agents", "brain-audit"),
      join("/roots/claude", "brain-audit"),
      join("/roots/agents", "brain-commit"),
      join("/roots/claude", "brain-commit"),
    ];

    expect(formatSkillTargets(skillMajor)).toBe(
      [
        join("/roots/agents", "brain-audit"),
        join("/roots/agents", "brain-commit"),
        join("/roots/claude", "brain-audit"),
        join("/roots/claude", "brain-commit"),
      ].join(", ")
    );
  });

  it("never mutates the array it is given", async () => {
    const { formatSkillTargets } = await import("../../src/commands/setup.js");
    const skillMajor = [join("/b"), join("/a")];
    formatSkillTargets(skillMajor);
    expect(skillMajor).toEqual([join("/b"), join("/a")]);
  });
});
