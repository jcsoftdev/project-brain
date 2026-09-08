import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { detectEnvironment, type Environment } from "../env/detect.js";
import { getRegistrars, type AIToolRegistrar } from "../registrars/types.js";
import { UnparseableConfigError, standardServerEntry } from "../registrars/json-config.js";
import { getGlobalRules } from "../rules/global.js";
import {
  parseModelRoutingFlag,
  parseRecordConnectionFlag,
  parseRoutingHookFlag,
  parseSkillInstallFlag,
  parseWorktreeHookFlag,
} from "../cli-args.js";
import { getSkillTargetDirs, installSkill, type SkippedTarget } from "../rules/skills.js";

export interface SetupOptions {
  dataDir?: string;
  skipOllama?: boolean;
  skipRegistration?: boolean;
  /** Injectable for testing; defaults to the real getRegistrars(). */
  registrars?: AIToolRegistrar[];
  /** Non-interactive override for the model-routing prompt. Defaults to "ask". */
  modelRouting?: "ask" | "yes" | "no";
  /** Injectable for testing; defaults to the real ~/.project-brain/model-routing.json. */
  routingConfigPath?: string;
  /** Whether to install the routing hooks into Claude Code's global settings. */
  routingHook?: { mode: "ask" | "yes" | "no"; strict: boolean };
  /**
   * Worktree hooks. Installation defaults to yes and is deliberately NOT tied to
   * `routingHook`: routing guidance is a preference, an index that outlives its worktree
   * is a bug. `strict` adds the blocking PreToolUse guard and is never a default.
   */
  worktreeHook?: { mode: "yes" | "no"; strict: boolean };
  /** Injectable for testing; defaults to ~/.claude/settings.json. */
  claudeSettingsPath?: string;
  /**
   * brain-record's connection-mode preference: whether the skill drives a
   * fresh, logged-out `--user-data-dir` Chrome profile (the safe default) or
   * the user's own logged-in session via the `chrome://inspect` remote-debugging
   * toggle, plus which CDP port to connect on. Never asked and never defaults to
   * "live" — see `parseRecordConnectionFlag`'s doc comment for why.
   */
  recordConnection?: { mode: "fresh" | "live"; cdpPort: number };
  /**
   * Injectable for testing; defaults to `<dataDir>/record-config.json`, NOT a
   * fixed homedir() constant — tying it to the already-injected `dataDir` is
   * what keeps every other setup test, which never mentions this preference,
   * from writing into the developer's real ~/.project-brain during a run.
   */
  recordConfigPath?: string;
  /** Injectable for testing; defaults to the real promptModelRouting from src/interactive.js. */
  promptModelRouting?: () => Promise<boolean>;
  /**
   * Non-interactive override for the brain-audit skill install. Defaults to
   * "ask", which resolves to INSTALL when non-interactive — unlike
   * modelRouting, the skill is part of what setup delivers.
   */
  skillInstall?: "ask" | "yes" | "no";
  /** Injectable for testing; defaults to the real promptSkillInstall from src/interactive.js. */
  promptSkillInstall?: () => Promise<boolean>;
  /**
   * Injectable for testing; defaults to getSkillTargetDirs(registeredTools).
   * Tests MUST set this — the default resolves against homedir(), so a suite
   * that injects fake registrars would otherwise write brain-audit into the
   * developer's real ~/.claude/skills.
   */
  skillTargetDirs?: string[];
}

export interface SetupResult {
  dataDir: string;
  env: Environment;
  registeredTools: string[];
  /** Every detected tool, whether or not its MCP registration succeeded.
   *  Skill targets derive from this, not from registeredTools. */
  installedTools: string[];
  /** Human-readable manual-setup instructions for registrars that could not
   *  safely auto-register (e.g. an unparseable config file). */
  manualInstructions: string[];
  /** Skill directories actually written. Empty when the install was
   *  declined, skipped, or had no target. */
  skillTargets: string[];
  /** Targets left untouched because ownership could not be proven. */
  skillSkipped: SkippedTarget[];
  /** Which routing hooks were installed into Claude Code's global settings. */
  routingHooks: { installed: boolean; strict: boolean };
  /** Whether the worktree hooks were written, and whether the spawn guard came with them. */
  worktreeHooks: { installed: boolean; strict: boolean };
  /** brain-record's connection-mode preference, as written to record-config.json. */
  recordConnection: { mode: "fresh" | "live"; cdpPort: number };
}

/** Tool names whose settings file is commonly hand-edited as JSONC (comments allowed). */
const JSONC_TOOLS = new Set(["Zed", "VS Code"]);

/**
 * Install the routing hooks into Claude Code's GLOBAL settings.json.
 *
 * Global, not project-level, because the routing rules are global — unlike the
 * `init` context hook, which is about one indexed project.
 *
 * Claude Code only: it is the one host verified to fire PreToolUse on a
 * sub-agent spawn and to accept `additionalContext` on SessionStart. Writing a
 * hook for a host that silently never fires it is worse than writing none.
 */
async function installRoutingHooks(
  targets: AIToolRegistrar[],
  options: SetupOptions,
  routingAccepted: boolean
): Promise<{ installed: boolean; strict: boolean }> {
  const { mode, strict } = options.routingHook ?? { mode: "ask", strict: false };
  if (mode === "no") return { installed: false, strict: false };

  // With no flag, the hooks ride on the ONE decision already made about
  // routing. Someone who declined the guidance did not ask to be reminded of
  // it every session, and asking a second question to install a reminder for
  // the answer to the first is how prompts get clicked through.
  if (mode === "ask" && !routingAccepted) return { installed: false, strict: false };

  const claude = targets.find((r) => r.routing?.hostKey === "claude");
  if (!claude) return { installed: false, strict: false };

  const settingsPath = options.claudeSettingsPath ?? defaultClaudeSettingsPath();

  try {
    const { upsertRoutingHooks } = await import("../hooks/claude-settings.js");

    let existing: object | null = null;
    try {
      existing = JSON.parse(await Bun.file(settingsPath).text());
    } catch {
      // Absent or unparseable. Absent is normal; unparseable is not ours to
      // repair — upsert starts from scratch rather than destroying it, so bail
      // out instead if there was real content.
      const raw = await Bun.file(settingsPath)
        .text()
        .catch(() => "");
      if (raw.trim().length > 0) {
        console.warn(
          `Warning: ${settingsPath} is not valid JSON — routing hooks not installed.`
        );
        return { installed: false, strict: false };
      }
    }

    await mkdir(join(settingsPath, ".."), { recursive: true });
    await Bun.write(settingsPath, `${JSON.stringify(upsertRoutingHooks(existing, { strict }), null, 2)}\n`);
    return { installed: true, strict };
  } catch (e: any) {
    console.warn(`Warning: Failed to install routing hooks: ${e.message}`);
    return { installed: false, strict: false };
  }
}

/**
 * Install the worktree hooks into Claude Code's settings.
 *
 * Not gated on the routing answer, and never asked about. The two hooks it writes are
 * hygiene, not guidance: one reclaims the vector table of a worktree git no longer
 * lists, the other tells a session it is sitting in a worktree whose brain is scoped to
 * a different branch. Both prevent wrong answers rather than offer advice, and the
 * SessionStart one stays silent in a main checkout, which is nearly every session.
 *
 * Claude Code only, for `installRoutingHooks`' reason: it is the host verified to fire
 * these events and to accept `additionalContext` on SessionStart.
 */
async function installWorktreeHooks(
  targets: AIToolRegistrar[],
  options: SetupOptions
): Promise<{ installed: boolean; strict: boolean }> {
  const NONE = { installed: false, strict: false };
  const { mode, strict } = options.worktreeHook ?? { mode: "yes" as const, strict: false };
  if (mode === "no") return NONE;

  const claude = targets.find((r) => r.routing?.hostKey === "claude");
  if (!claude) return NONE;

  const settingsPath = options.claudeSettingsPath ?? defaultClaudeSettingsPath();

  try {
    const { upsertWorktreeHooks } = await import("../hooks/claude-settings.js");

    let existing: object | null = null;
    try {
      existing = JSON.parse(await Bun.file(settingsPath).text());
    } catch {
      // Absent is normal. Unparseable is not ours to repair: upserting from scratch
      // would silently replace whatever the user has there.
      const raw = await Bun.file(settingsPath)
        .text()
        .catch(() => "");
      if (raw.trim().length > 0) {
        console.warn(`Warning: ${settingsPath} is not valid JSON — worktree hooks not installed.`);
        return NONE;
      }
    }

    await mkdir(join(settingsPath, ".."), { recursive: true });
    await Bun.write(
      settingsPath,
      `${JSON.stringify(upsertWorktreeHooks(existing, { strict }), null, 2)}\n`
    );
    return { installed: true, strict };
  } catch (e: any) {
    console.warn(`Warning: Failed to install worktree hooks: ${e.message}`);
    return NONE;
  }
}

/**
 * Persist brain-record's connection-mode preference to
 * `<dataDir>/record-config.json`.
 *
 * Unlike the routing/worktree hooks, this is a small standalone preference
 * file this generator fully owns — not a shared settings.json belonging to
 * some other tool that has to be merged into. So there is nothing to ask
 * about (no `mode: "ask"`) and no ownership check: it is always (re)written,
 * the way `renderStamp` always rewrites the skill stamp. `mode` defaults to
 * "fresh", the safe choice that needs no flag; "live" always requires one —
 * see `SetupOptions.recordConnection`.
 */
async function writeRecordConnectionConfig(
  dataDir: string,
  options: SetupOptions
): Promise<{ mode: "fresh" | "live"; cdpPort: number }> {
  const config = options.recordConnection ?? { mode: "fresh" as const, cdpPort: 9222 };
  const path = options.recordConfigPath ?? join(dataDir, "record-config.json");

  try {
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
  } catch (e: any) {
    console.warn(`Warning: Failed to write brain-record connection config: ${e.message}`);
  }

  return config;
}

/**
 * Write the model-routing section to every eligible host, asking at most once.
 *
 * Three states, three behaviours:
 *   - nothing written  → ask (opt-out: the default answer is yes)
 *   - stale version    → rewrite silently; consent was already given, and
 *                        re-asking on every content update teaches people to
 *                        decline
 *   - current version  → leave it alone
 *
 * A failure on one host is reported and skipped, never fatal: a full disk in
 * ~/.codex must not cost the user their CLAUDE.md section.
 */
async function writeRoutingGuidance(
  targets: AIToolRegistrar[],
  options: SetupOptions
): Promise<boolean> {
  const mode = options.modelRouting ?? "ask";
  if (mode === "no") return false;

  const eligible = targets.filter((r) => r.routing && r.writeModelRouting);
  if (eligible.length === 0) return false;

  // Version state is read before prompting: if every host is already current
  // there is nothing to ask about.
  const states = await Promise.all(
    eligible.map(async (registrar) => {
      try {
        return { registrar, written: (await registrar.writtenRoutingVersion?.()) ?? null };
      } catch {
        return { registrar, written: null };
      }
    })
  );

  const { ROUTING_CONTENT_VERSION } = await import("../constants.js");
  const pending = states.filter((s) => s.written === null || s.written < ROUTING_CONTENT_VERSION);
  // Everything already current still counts as accepted — the guidance IS in
  // place, which is what the caller is asking about.
  if (pending.length === 0) return true;

  if (mode === "ask" && pending.some((s) => s.written === null)) {
    const prompt =
      options.promptModelRouting ?? (await import("../interactive.js")).promptModelRouting;
    if (!(await prompt())) return false;
  }

  const { loadRoutingConfig } = await import("../rules/model-routing-config.js");
  const resolved = await loadRoutingConfig(options.routingConfigPath);
  for (const warning of resolved.warnings) console.warn(`Warning: ${warning}`);

  const { getModelRoutingSection } = await import("../rules/model-routing.js");

  let wrote = false;
  for (const { registrar } of pending) {
    try {
      await registrar.writeModelRouting!(await getModelRoutingSection(registrar, resolved));
      wrote = true;
    } catch (e: any) {
      console.warn(
        `Warning: Failed to write model-routing guidance for ${registrar.name}: ${e.message}`
      );
    }
  }
  return wrote;
}

function buildManualInstructions(
  toolName: string,
  err: UnparseableConfigError
): string {
  const jsoncHint = JSONC_TOOLS.has(toolName)
    ? ` This file commonly contains JSONC comments — project-brain does not rewrite JSONC files to avoid stripping your comments.`
    : "";
  const snippet = JSON.stringify(
    standardServerEntry("<path-to-project-brain>"),
    null,
    2
  );
  return (
    `${toolName} config at ${err.configPath} is not valid JSON (JSONC/comments?)` +
    ` — add this entry manually:${jsoncHint}\n${snippet}`
  );
}

/**
 * Where Claude Code keeps its settings, with an env override that exists for one
 * concrete reason: **Bun's `os.homedir()` ignores a runtime `HOME` change.**
 *
 *   bun  -e 'process.env.HOME="/tmp/x"; homedir()'  -> the real home
 *   node -e 'process.env.HOME="/tmp/x"; homedir()'  -> /tmp/x
 *
 * So a test running under `bun test` CANNOT redirect this path by setting HOME,
 * and 27 of the runSetup calls in the suite pass no explicit path. A full
 * `bun test` run was observed writing real hooks into a developer's own
 * settings.json. The routing installer hid the same hazard because it returns
 * early without consent; the worktree installer is ungated and fired every time.
 */
function defaultClaudeSettingsPath(): string {
  return process.env.BRAIN_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
}

const DEFAULT_DATA_DIR = join(homedir(), ".project-brain");

/**
 * Core setup logic — testable with injectable options.
 */
export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;

  // 1. Create data directory
  await mkdir(dataDir, { recursive: true });

  // 2. Detect environment
  const env = await detectEnvironment();

  // 3. Pull Ollama model if available (and not skipped)
  if (!options.skipOllama && env.ollama.available) {
    if (!env.ollama.models.includes("nomic-embed-text")) {
      try {
        const proc = Bun.spawn(["ollama", "pull", "nomic-embed-text"], {
          stdout: "inherit",
          stderr: "inherit",
        });
        await proc.exited;
      } catch {
        console.warn("Warning: Failed to pull Ollama model.");
      }
    }
  } else if (!options.skipOllama && !env.ollama.available) {
    console.warn(
      "Warning: Ollama not available. Embedding features will be degraded."
    );
  }

  // 4. Register in AI tools
  const registeredTools: string[] = [];
  /** Every detected tool, whether or not its MCP registration succeeded. */
  const installedTools: string[] = [];
  const manualInstructions: string[] = [];
  /** Registered hosts that can carry a model-routing section. */
  const routingTargets: AIToolRegistrar[] = [];

  if (!options.skipRegistration) {
    const registrars = options.registrars ?? (await getRegistrars());
    const serverPath =
      Bun.which("project-brain") ??
      join(import.meta.dir, "../../src/cli.ts");

    for (const registrar of registrars) {
      const installed = await registrar.isInstalled();
      if (!installed) continue;

      // Skill targets follow INSTALLED, not REGISTERED.
      //
      // A skill is a directory of markdown the host reads on its own; it needs
      // no MCP server behind it. Gating it on registration success meant one
      // unparseable config file silently cost the user every skill for that
      // tool — two unrelated failures welded together.
      installedTools.push(registrar.name);

      let registered = false;
      try {
        await registrar.register(serverPath);

        // Determine tool key for template loading
        const toolKey = registrar.name
          .toLowerCase()
          .replace(/\s+/g, "")
          .replace("claudecode", "claude")
          .replace("geminicli", "gemini");
        const rules = await getGlobalRules(toolKey);
        await registrar.writeRules(rules);
        registeredTools.push(registrar.name);
        registered = true;
      } catch (e: any) {
        if (e instanceof UnparseableConfigError) {
          manualInstructions.push(buildManualInstructions(registrar.name, e));
        } else {
          console.warn(`Warning: Failed to register in ${registrar.name}: ${e.message}`);
        }
      }

      if (registered) {
        routingTargets.push(registrar);
      }
    }
  }

  // 4b. Model-routing guidance, once across every eligible host.
  //
  // Deliberately AFTER the registrar loop, not inside it: the decision is one
  // decision. Asking per host turned a single yes into six chances to
  // accidentally say no, and the answer is never host-specific — only the
  // rendered text is.
  const routingAccepted = await writeRoutingGuidance(routingTargets, options);
  const routingHooks = await installRoutingHooks(routingTargets, options, routingAccepted);
  // After the routing hooks, never before: both write the same file, and this one must
  // merge into whatever they left rather than be overwritten by them.
  const worktreeHooks = await installWorktreeHooks(routingTargets, options);
  // Independent of both — its own file, no registrar, nothing to merge into.
  const recordConnection = await writeRecordConnectionConfig(dataDir, options);

  // 5. Install the brain-audit skill.
  //
  // Runs once after the registrar loop, not per registrar: six of the eight
  // tools share ~/.agents/skills, and getSkillTargetDirs already dedupes them.
  let skillTargets: string[] = [];
  let skillSkipped: SkippedTarget[] = [];

  const skillMode = options.skillInstall ?? "ask";
  const skillDirs = options.skillTargetDirs ?? getSkillTargetDirs(installedTools);

  if (skillMode !== "no" && skillDirs.length > 0) {
    try {
      const prompt =
        options.promptSkillInstall ?? (await import("../interactive.js")).promptSkillInstall;
      const accepted = skillMode === "yes" ? true : await prompt();
      if (accepted) {
        const outcome = await installSkill(skillDirs);
        skillTargets = outcome.written;
        skillSkipped = outcome.skipped;
      }
    } catch (e: any) {
      console.warn(`Warning: Failed to install skills: ${e.message}`);
    }
  } else if (skillMode !== "no") {
    // Say so. A silent skip here is indistinguishable from a broken install:
    // the user runs setup, sees nothing about skills, and has no thread to pull.
    console.warn(
      "Warning: No skill targets found — no supported AI tool was detected," +
        " so no skills were installed."
    );
  }

  for (const target of skillSkipped) {
    console.warn(
      `Warning: ${target.dir} already exists and was not created by project-brain` +
        ` — left untouched. Move or delete it, then re-run setup.`
    );
  }

  return {
    dataDir,
    env,
    registeredTools,
    installedTools,
    manualInstructions,
    skillTargets,
    skillSkipped,
    routingHooks,
    worktreeHooks,
    recordConnection,
  };
}

/**
 * Deterministic, grouped-by-directory text for the "Skill installed in:" line.
 *
 * `installSkill` (via Task 4's `installOneSkill`) produces `written` in
 * skill-major order — every root for skill A, then every root for skill B —
 * not the dir-major order it used to. That reorder is invisible to
 * `InstallResult`'s own tests, but this is the one place it was user-visible:
 * with two or more skill target roots (Claude Code + Codex + the shared
 * `~/.agents/skills` is the normal case), the raw array interleaves
 * directories instead of grouping them. Sorting a COPY here — never
 * `result.skillTargets` itself — keeps the installer's own ordering exactly as
 * it produces it; this is a display concern only.
 */
export function formatSkillTargets(skillTargets: string[]): string {
  return [...skillTargets].sort().join(", ");
}

/** CLI entry point for the setup command. */
export async function execute(args: string[]): Promise<void> {
  console.log("project-brain setup\n");

  const modelRouting = parseModelRoutingFlag(args);
  const skillInstall = parseSkillInstallFlag(args);
  const routingHook = parseRoutingHookFlag(args);
  const worktreeHook = parseWorktreeHookFlag(args);
  const recordConnection = parseRecordConnectionFlag(args);
  const result = await runSetup({
    modelRouting,
    skillInstall,
    routingHook,
    worktreeHook,
    recordConnection,
  });

  console.log(`Environment:`);
  console.log(`  Bun: ${result.env.bun}`);
  console.log(`  Platform: ${result.env.platform} (${result.env.arch})`);
  console.log(
    `  Ollama: ${result.env.ollama.available ? "available" : "not found"}`
  );
  console.log(`  Data dir: ${result.dataDir}`);

  console.log(`\nAI Tools:`);
  for (const tool of result.env.aiTools) {
    const status = tool.installed ? "✓" : "✗";
    console.log(`  ${status} ${tool.name}`);
  }

  if (result.registeredTools.length > 0) {
    console.log(`\nRegistered in: ${result.registeredTools.join(", ")}`);
  }

  if (result.skillTargets.length === 0) {
    // Reported unconditionally: "nothing about skills" used to be the output
    // for both "you declined" and "detection failed", which is the whole
    // reason a broken install could go unnoticed.
    console.log(`\nSkills: none installed.`);
  }

  if (result.skillTargets.length > 0) {
    console.log(`\nSkill installed in: ${formatSkillTargets(result.skillTargets)}`);
  }

  if (result.routingHooks.installed) {
    console.log(
      `\nModel-routing hooks: SessionStart reminder installed${
        result.routingHooks.strict ? ", PreToolUse guard enforcing" : ""
      }.`
    );
  }

  if (result.worktreeHooks.installed) {
    console.log(
      "\nWorktree hooks: SessionStart identity + WorktreeRemove index cleanup installed" +
        (result.worktreeHooks.strict ? ", PreToolUse spawn guard enforcing" : "") +
        "."
    );
  }

  console.log(
    `\nbrain-record connection: ${result.recordConnection.mode}` +
      (result.recordConnection.mode === "live"
        ? " (your logged-in Chrome via chrome://inspect — full browser control)"
        : " (fresh, logged-out Chrome profile)") +
      `, CDP port ${result.recordConnection.cdpPort}.`
  );

  if (result.manualInstructions.length > 0) {
    console.log(`\nManual setup needed:`);
    for (const instructions of result.manualInstructions) {
      console.log(`\n${instructions}`);
    }
  }

  console.log("\nSetup complete. Run `project-brain init` in a project.");
}
