import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { detectEnvironment, type Environment } from "../env/detect.js";
import { getRegistrars, type AIToolRegistrar } from "../registrars/types.js";
import { UnparseableConfigError, standardServerEntry } from "../registrars/json-config.js";
import {
  parseRecordConnectionFlag,
  parseRoutingHookFlag,
  parseUnitFlags,
  parseWorktreeHookFlag,
} from "../cli-args.js";
import { getSkillTargetDirs, inspectOwnership, type SkippedTarget } from "../rules/skills.js";
import { allUnits, type SetupContext, type UnitState } from "../setup/units.js";
import { computePlan, initialChecked, type PlanRow } from "../setup/plan.js";
import { loadSelection, saveSelection, membership } from "../setup/selection.js";
import { VERSION } from "../constants.js";

export interface SetupOptions {
  dataDir?: string;
  skipOllama?: boolean;
  skipRegistration?: boolean;
  /** Injectable for testing; defaults to the real getRegistrars(). */
  registrars?: AIToolRegistrar[];
  /** Injectable for testing; defaults to the real ~/.project-brain/model-routing.json. */
  routingConfigPath?: string;
  /** Whether the PreToolUse routing guard should be strict, if "hooks:routing" is selected. */
  routingHook?: { strict: boolean };
  /**
   * Worktree-hook strictness. Whether the hooks themselves are installed is the
   * "hooks:worktree" unit's own concern; `strict` adds the blocking PreToolUse
   * guard and is never a default.
   */
  worktreeHook?: { strict: boolean };
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
  /**
   * Injectable for testing; defaults to getSkillTargetDirs(registeredTools).
   * Tests MUST set this — the default resolves against homedir(), so a suite
   * that injects fake registrars would otherwise write skills into the
   * developer's real ~/.claude/skills.
   */
  skillTargetDirs?: string[];
  /**
   * Injectable for testing; defaults to `<dataDir>/setup-selection.json`.
   *
   * Tied to the already-injected `dataDir` rather than a homedir() constant,
   * exactly like `recordConfigPath` — and for a sharper reason: the units this
   * path governs can DELETE, and `os.homedir()` under `bun test` ignores a
   * runtime HOME change, so a suite cannot redirect a homedir default.
   */
  selectionPath?: string;
  /** Non-interactive override for the unit checklist, from `parseUnitFlags`. */
  units?: { mode: "default" | "explicit"; selected: string[] };
  /**
   * Injectable for testing; defaults to the real `promptUnitSelection` from
   * `src/interactive.js`. Every other prompt in this file is injectable and the
   * existing suite depends on that, so this one is too.
   */
  promptUnitSelection?: (rows: Omit<PlanRow, "action">[]) => Promise<string[] | null>;
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
  /** Every unit, its inspected state and the action taken. */
  units: PlanRow[];
  /** Where the selection was written. */
  selectionPath: string;
}

/** Tool names whose settings file is commonly hand-edited as JSONC (comments allowed). */
const JSONC_TOOLS = new Set(["Zed", "VS Code"]);

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
 * and the suite has calls that pass no explicit path. A full `bun test` run was
 * once observed writing real hooks into a developer's own settings.json.
 */
function defaultClaudeSettingsPath(): string {
  return process.env.BRAIN_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
}

const DEFAULT_DATA_DIR = join(homedir(), ".project-brain");

/**
 * Assemble the final `SetupResult` from the plan, in the one place both the
 * cancel path and the normal return call into — so the two can never disagree
 * about the shape they hand back.
 *
 * `failed` names unit ids whose `apply()`/`remove()` threw during this run
 * (empty on the cancel path, since nothing was ever applied). It is what keeps
 * `registeredTools` reporting only hosts that ACTUALLY registered, not merely
 * hosts the plan intended to register — a distinction the plan alone cannot
 * make, because its `action` is computed before apply() ever runs.
 */
async function buildResult(
  ctx: SetupContext,
  env: Environment,
  dataDir: string,
  plan: PlanRow[],
  manualInstructions: string[],
  failed: Set<string> = new Set()
): Promise<SetupResult> {
  const acted = (id: string) =>
    plan.some((p) => p.id === id && (p.action === "install" || p.action === "update"));

  const routingHooks = {
    installed: acted("hooks:routing"),
    strict: ctx.hookStrict.routing && acted("hooks:routing"),
  };
  const worktreeHooks = {
    installed: acted("hooks:worktree"),
    strict: ctx.hookStrict.worktree && acted("hooks:worktree"),
  };
  const skillTargets = plan
    .filter((p) => p.group === "Skills" && (p.action === "install" || p.action === "update"))
    .flatMap((p) => ctx.skillTargetDirs.map((d) => join(d, p.label)));
  const registeredTools = plan
    .filter(
      (p) =>
        p.group === "Hosts" &&
        (p.action === "install" || p.action === "update") &&
        !failed.has(p.id)
    )
    .map((p) => p.label);

  // A `blocked` skill (a foreign copy on at least one root) does not go
  // through `installOneSkill`, which is where the old `skillSkipped` entries
  // used to come from — the unit is all-or-nothing, so `apply()` is never
  // called for it. Re-checking ownership here, only for blocked skill rows,
  // is what keeps this field naming the SPECIFIC foreign directory rather
  // than guessing from the unit's single aggregate state.
  const skillSkipped: SkippedTarget[] = [];
  for (const row of plan) {
    if (row.group !== "Skills" || row.action !== "blocked") continue;
    for (const root of ctx.skillTargetDirs) {
      const dir = join(root, row.label);
      const ownership = await inspectOwnership(dir);
      if (ownership !== "absent" && ownership !== "ours") {
        skillSkipped.push({ dir, reason: ownership });
      }
    }
  }

  return {
    dataDir,
    env,
    registeredTools,
    installedTools: ctx.installed.map((r) => r.name),
    manualInstructions,
    skillTargets,
    skillSkipped,
    routingHooks,
    worktreeHooks,
    recordConnection: ctx.recordConnection,
    units: plan,
    selectionPath: ctx.selectionPath,
  };
}

/**
 * Core setup logic — testable with injectable options.
 */
export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;

  // 1. Create data directory
  await mkdir(dataDir, { recursive: true });

  // 2. Detect environment
  const env = await detectEnvironment();

  // 3. Ollama pulling is a unit now (`embed:ollama-model`) — no standalone step here.

  // 4. Detect hosts. Registration itself is a unit, so this loop only detects.
  const installedRegistrars: AIToolRegistrar[] = [];
  if (!options.skipRegistration) {
    const registrars = options.registrars ?? (await getRegistrars());
    for (const registrar of registrars) {
      if (await registrar.isInstalled()) installedRegistrars.push(registrar);
    }
  }

  const ctx: SetupContext = {
    dataDir,
    installed: installedRegistrars,
    serverPath: Bun.which("project-brain") ?? join(import.meta.dir, "../../src/cli.ts"),
    claudeSettingsPath: options.claudeSettingsPath ?? defaultClaudeSettingsPath(),
    recordConfigPath: options.recordConfigPath ?? join(dataDir, "record-config.json"),
    selectionPath: options.selectionPath ?? join(dataDir, "setup-selection.json"),
    skillTargetDirs:
      options.skillTargetDirs ?? getSkillTargetDirs(installedRegistrars.map((r) => r.name)),
    recordConnection: options.recordConnection ?? { mode: "fresh", cdpPort: 9222 },
    hookStrict: {
      routing: options.routingHook?.strict ?? false,
      worktree: options.worktreeHook?.strict ?? false,
    },
    skipOllama: options.skipOllama ?? false,
    routingConfigPath: options.routingConfigPath,
  };

  // Preserved from the previous implementation: UnparseableConfigError from a
  // host's apply() still becomes a manual-setup instruction in the result.
  const manualInstructions: string[] = [];

  // 5. Inspect every unit BEFORE anything is drawn or written. This is what
  // lets the checklist report disk rather than assumption.
  const units = allUnits(ctx);
  const selection = await loadSelection(ctx.selectionPath);

  const inspected = await Promise.all(
    units.map(async (unit) => {
      const state = await unit.inspect(ctx).catch(() => "absent" as UnitState);
      const seen = membership(selection, unit.id);
      return {
        id: unit.id,
        label: unit.label,
        group: unit.group,
        description: unit.description,
        state,
        membership: seen,
        chosen: initialChecked(state, seen, unit.defaultSelected),
      };
    })
  );

  // 6. Resolve the ticks: explicit flags win, then the prompt, then the seeds.
  let chosenIds: string[];
  if (options.units?.mode === "explicit") {
    chosenIds = options.units.selected;
  } else {
    const answer = await (options.promptUnitSelection ??
      (await import("../interactive.js")).promptUnitSelection)(inspected);
    if (answer === null) {
      // Cancelled. Write nothing, including the selection file.
      return buildResult(
        ctx,
        env,
        dataDir,
        computePlan(inspected.map((r) => ({ ...r, chosen: false }))),
        manualInstructions
      );
    }
    chosenIds = answer;
  }

  const chosen = new Set(chosenIds);
  const plan = computePlan(inspected.map((row) => ({ ...row, chosen: chosen.has(row.id) })));

  // 7. Apply.
  const byId = new Map(units.map((u) => [u.id, u]));
  const failed = new Set<string>();
  for (const row of plan) {
    const unit = byId.get(row.id)!;
    try {
      if (row.action === "install" || row.action === "update") await unit.apply(ctx);
      else if (row.action === "remove") await unit.remove(ctx);
    } catch (e: any) {
      failed.add(row.id);
      if (e instanceof UnparseableConfigError) {
        manualInstructions.push(buildManualInstructions(row.label, e));
      } else {
        console.warn(`Warning: ${row.action} failed for ${row.label}: ${e.message}`);
      }
    }
  }

  // 8. Persist the choice. Written AFTER applying so a crash mid-apply does not
  // record a state the disk never reached.
  await saveSelection(
    ctx.selectionPath,
    chosenIds,
    units.map((u) => u.id),
    VERSION
  );

  return buildResult(ctx, env, dataDir, plan, manualInstructions, failed);
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
 *
 * `skillTargets` is now skill-major for the same reason on the setup-unit
 * path (Task 11 derives it by iterating the plan's Skills group, one unit —
 * one skill — at a time), so this sort is still load-bearing.
 */
export function formatSkillTargets(skillTargets: string[]): string {
  return [...skillTargets].sort().join(", ");
}

/**
 * Build a `SetupContext` from detection alone, with no consent step and no
 * writes — just enough to know the real unit id list.
 *
 * `execute()` needs that list before it can resolve `--with`/`--without`
 * flags via `parseUnitFlags`, and `runSetup()` builds its own context moments
 * later. Sharing this helper is what keeps the two from ever disagreeing
 * about which ids exist.
 */
export async function probeContext(options: {
  recordConnection?: { mode: "fresh" | "live"; cdpPort: number };
  routingHook?: { strict: boolean };
  worktreeHook?: { strict: boolean };
  routingConfigPath?: string;
} = {}): Promise<SetupContext> {
  const dataDir = DEFAULT_DATA_DIR;
  const registrars = await getRegistrars();
  const installed: AIToolRegistrar[] = [];
  for (const registrar of registrars) {
    if (await registrar.isInstalled()) installed.push(registrar);
  }

  return {
    dataDir,
    installed,
    serverPath: Bun.which("project-brain") ?? join(import.meta.dir, "../../src/cli.ts"),
    claudeSettingsPath: defaultClaudeSettingsPath(),
    recordConfigPath: join(dataDir, "record-config.json"),
    selectionPath: join(dataDir, "setup-selection.json"),
    skillTargetDirs: getSkillTargetDirs(installed.map((r) => r.name)),
    recordConnection: options.recordConnection ?? { mode: "fresh", cdpPort: 9222 },
    hookStrict: {
      routing: options.routingHook?.strict ?? false,
      worktree: options.worktreeHook?.strict ?? false,
    },
    skipOllama: false,
    routingConfigPath: options.routingConfigPath,
  };
}

/** CLI entry point for the setup command. */
export async function execute(args: string[]): Promise<void> {
  console.log("project-brain setup\n");

  const recordConnection = parseRecordConnectionFlag(args);
  const routingHook = parseRoutingHookFlag(args);
  const worktreeHook = parseWorktreeHookFlag(args);

  // The id list needs a context, and a context needs detection — so this runs
  // a detection-only pass first. Cheap: `isInstalled()` is a file stat per host.
  const probe = await probeContext({ recordConnection, routingHook, worktreeHook });
  const ids = allUnits(probe).map((u) => u.id);

  const units = parseUnitFlags(args, ids);
  if (units.mode === undefined) {
    console.error(units.error);
    process.exit(1);
    return;
  }

  const result = await runSetup({ recordConnection, routingHook, worktreeHook, units });

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

  console.log(`\nSelection saved to ${result.selectionPath}`);

  console.log("\nSetup complete. Run `project-brain init` in a project.");
}
