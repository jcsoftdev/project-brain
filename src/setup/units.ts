import { join } from "node:path";
import type { AIToolRegistrar } from "../registrars/types.js";

/**
 * What one setup unit looks like on disk right now.
 *
 * `unavailable` is not a failure — it means the unit cannot apply on this
 * machine at all (no host detected, no skills root, Ollama absent). Such a unit
 * is shown with its reason and no checkbox rather than hidden, so nobody has to
 * wonder why a skill they expected is missing from the list.
 */
export type UnitState = "absent" | "current" | "stale" | "foreign" | "unavailable";

/** Everything a unit needs, and every path a test must be able to redirect. */
export interface SetupContext {
  dataDir: string;
  /** Registrars whose `isInstalled()` returned true. */
  installed: AIToolRegistrar[];
  /** Path the MCP entry should point at. */
  serverPath: string;
  claudeSettingsPath: string;
  recordConfigPath: string;
  selectionPath: string;
  skillTargetDirs: string[];
  recordConnection: { mode: "fresh" | "live"; cdpPort: number };
  hookStrict: { routing: boolean; worktree: boolean };
  skipOllama: boolean;
}

/**
 * One installable surface, in the one shape every surface now shares.
 *
 * Before this existed, five surfaces had five different consent shapes: MCP
 * registration and the worktree hooks were automatic, the routing hooks rode on
 * the model-routing answer, `record-config.json` was always rewritten, and five
 * skills shared a single yes/no. Nothing could be chosen independently because
 * nothing agreed on what "chosen" meant.
 */
export interface SetupUnit {
  /** Stable across releases — it is persisted in the selection file. */
  id: string;
  group: "Hosts" | "Guidance" | "Skills" | "Other";
  label: string;
  /** One line, shown beside the checkbox. */
  description: string;
  /** Checked the first time this unit is ever offered. */
  defaultSelected: boolean;

  inspect(ctx: SetupContext): Promise<UnitState>;
  apply(ctx: SetupContext): Promise<void>;
  remove(ctx: SetupContext): Promise<void>;
}

/** One-line descriptions, kept beside the ids they belong to. */
const SKILL_DESCRIPTIONS: Record<string, string> = {
  "brain-audit": "whole-project audit: dead code, orphan UI, broken flows, security findings",
  "brain-commit": "writes commit messages in the convention the repository already uses",
  "brain-okf": "records the reasoning behind code as an Open Knowledge Format concept",
  "brain-record": "records a branch's flow as video evidence for a PR or ticket",
  "brain-worktree": "gives an isolated worktree its own brain and its own port",
};

/**
 * A unit per shipped skill.
 *
 * Every target directory is treated as one unit: a skill is either installed
 * everywhere it can go or nowhere. Per-root selection would be a second axis
 * nobody asked for, and six of the eight hosts share `~/.agents/skills` anyway.
 * `inspect` therefore reports the WORST state across roots, so a single stale
 * or foreign copy is visible rather than averaged away.
 */
export function skillUnits(): SetupUnit[] {
  // Imported lazily inside each method: the skills module embeds every shipped
  // markdown file as a string, and the flag parser must not pay for that.
  return Object.keys(SKILL_DESCRIPTIONS).map((name) => ({
    id: `skill:${name}`,
    group: "Skills" as const,
    label: name,
    description: SKILL_DESCRIPTIONS[name]!,
    defaultSelected: true,

    async inspect(ctx: SetupContext): Promise<UnitState> {
      if (ctx.skillTargetDirs.length === 0) return "unavailable";
      const { inspectOwnership, readSkillStamp, MANIFEST_STAMP } = await import(
        "../rules/skills.js"
      );

      const states: UnitState[] = [];
      for (const root of ctx.skillTargetDirs) {
        const skillDir = join(root, name);
        const ownership = await inspectOwnership(skillDir);
        if (ownership === "absent") states.push("absent");
        else if (ownership !== "ours") states.push("foreign");
        else {
          const stamp = await readSkillStamp(skillDir);
          states.push(stamp.hash === MANIFEST_STAMP ? "current" : "stale");
        }
      }

      // Worst-first: a problem anywhere is the answer.
      for (const worst of ["foreign", "stale", "absent"] as const) {
        if (states.includes(worst)) return worst;
      }
      return "current";
    },

    async apply(ctx: SetupContext): Promise<void> {
      const { installOneSkill } = await import("../rules/skills.js");
      await installOneSkill(ctx.skillTargetDirs, name);
    },

    async remove(ctx: SetupContext): Promise<void> {
      const { removeSkill } = await import("../rules/skills.js");
      for (const root of ctx.skillTargetDirs) {
        await removeSkill(join(root, name));
      }
    },
  }));
}

/**
 * The id segment for a host.
 *
 * Lowercase with whitespace stripped, so "Claude Code" and "Gemini CLI" produce
 * ids stable enough to persist: `host:claudecode`, `host:geminicli`. Derived
 * rather than hand-mapped because the registrar list is the source of truth for
 * which hosts exist.
 */
export function hostKeyOf(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "");
}

/**
 * A unit per detected host: the MCP registration and its rules file together.
 *
 * The two are ONE unit on purpose. A rules file describing an MCP server that
 * was never registered is instructions for a tool that is not there, and
 * splitting them would let a user build exactly that state.
 *
 * `inspect` can only answer honestly for hosts that expose
 * `mcpConfigTarget()`. Codex registers through `codex mcp add` against a TOML
 * only that CLI can safely rewrite, so it reports `absent` and re-applying is a
 * harmless no-op — better than claiming a state we cannot read.
 */
export function hostUnits(installed: AIToolRegistrar[]): SetupUnit[] {
  return installed.map((registrar) => ({
    id: `host:${hostKeyOf(registrar.name)}`,
    group: "Hosts" as const,
    label: registrar.name,
    description: "registers the project-brain MCP server and writes its rules file",
    defaultSelected: true,

    async inspect(ctx: SetupContext): Promise<UnitState> {
      const present = ctx.installed.some((r) => r.name === registrar.name);
      if (!present) return "unavailable";

      const target = registrar.mcpConfigTarget?.();
      if (!target) return "absent";

      try {
        const parsed = JSON.parse(await Bun.file(target.path).text()) as Record<string, unknown>;
        const container = parsed[target.containerKey] as Record<string, unknown> | undefined;
        return container && "project-brain" in container ? "current" : "absent";
      } catch {
        // Missing file, or JSONC we refuse to parse. Both mean "not registered
        // as far as we can prove", and apply() handles the JSONC case by
        // raising UnparseableConfigError, which setup already reports.
        return "absent";
      }
    },

    async apply(ctx: SetupContext): Promise<void> {
      await registrar.register(ctx.serverPath);
      const { getGlobalRules } = await import("../rules/global.js");
      const toolKey = hostKeyOf(registrar.name)
        .replace("claudecode", "claude")
        .replace("geminicli", "gemini");
      await registrar.writeRules(await getGlobalRules(toolKey));
    },

    async remove(_ctx: SetupContext): Promise<void> {
      const { removeSection } = await import("../rules/section-marker.js");
      const target = registrar.mcpConfigTarget?.();

      if (target) {
        try {
          const parsed = JSON.parse(await Bun.file(target.path).text()) as Record<string, unknown>;
          const container = parsed[target.containerKey] as Record<string, unknown> | undefined;
          if (container && "project-brain" in container) {
            delete container["project-brain"];
            await Bun.write(target.path, `${JSON.stringify(parsed, null, 2)}\n`);
          }
        } catch {
          // Unparseable is not ours to repair — the same rule the installers use.
        }
      }

      // The rules file is a marked section inside a file the user owns, so only
      // our section goes. `removeSection` no-ops when the markers are absent.
      const rulesPath = registrar.rulesFilePath?.();
      if (rulesPath) await removeSection(rulesPath);
    },
  }));
}

/**
 * Read Claude Code's settings, distinguishing "absent" from "not ours".
 *
 * `null` means there is nothing there, which is normal on a first run.
 * `"unparseable"` means there IS content we cannot parse, and every caller
 * treats that as untouchable: rewriting it from scratch would silently replace
 * whatever the user has.
 */
async function readClaudeSettings(
  path: string
): Promise<Record<string, unknown> | null | "unparseable"> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return null;
  }
  if (raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "unparseable";
  }
}

/** True when any hook group anywhere in the settings runs `command`. */
function settingsHaveCommand(settings: Record<string, unknown> | null, command: string): boolean {
  if (!settings) return false;
  return JSON.stringify(settings.hooks ?? {}).includes(command);
}

/**
 * Build a unit for one hook pair, since routing and worktree differ only in
 * which functions they call and which command proves they are installed.
 *
 * `load` is a closure rather than the two functions directly because
 * `claude-settings.js` is imported lazily — the flag parser and the checklist
 * must not pay to load it just to know a unit exists.
 */
function hookUnit(spec: {
  id: string;
  label: string;
  description: string;
  probe: string;
  strictOf: (ctx: SetupContext) => boolean;
  load: () => Promise<{
    upsert: (existing: object | null, options: { strict: boolean }) => object;
    remove: (existing: object | null) => object;
  }>;
}): SetupUnit {
  return {
    id: spec.id,
    group: "Guidance",
    label: spec.label,
    description: spec.description,
    defaultSelected: true,

    async inspect(ctx) {
      const settings = await readClaudeSettings(ctx.claudeSettingsPath);
      if (settings === "unparseable") return "foreign";
      return settingsHaveCommand(settings, spec.probe) ? "current" : "absent";
    },

    async apply(ctx) {
      const settings = await readClaudeSettings(ctx.claudeSettingsPath);
      if (settings === "unparseable") {
        console.warn(
          `Warning: ${ctx.claudeSettingsPath} is not valid JSON — ${spec.label} not installed.`
        );
        return;
      }
      const { upsert } = await spec.load();
      const next = upsert(settings, { strict: spec.strictOf(ctx) });
      await Bun.write(ctx.claudeSettingsPath, `${JSON.stringify(next, null, 2)}\n`);
    },

    async remove(ctx) {
      const settings = await readClaudeSettings(ctx.claudeSettingsPath);
      if (settings === "unparseable" || settings === null) return;
      const { remove } = await spec.load();
      const next = remove(settings);
      await Bun.write(ctx.claudeSettingsPath, `${JSON.stringify(next, null, 2)}\n`);
    },
  };
}

/**
 * The model-routing guidance and the two hook pairs.
 *
 * All three used to share one consent decision — the hooks rode on the answer
 * to the guidance prompt, and the worktree hooks were never asked about at all.
 * They are three units now because they are three choices, and someone who
 * wants the reminder without the section (or the reverse) can now say so.
 */
export function guidanceUnits(): SetupUnit[] {
  return [
    {
      id: "guidance:model-routing",
      group: "Guidance",
      label: "Model-routing guidance",
      description: "which tier to use per task when delegating, written into each host's rules",
      defaultSelected: true,

      async inspect(ctx): Promise<UnitState> {
        const eligible = ctx.installed.filter((r) => r.routing && r.writeModelRouting);
        if (eligible.length === 0) return "unavailable";

        const { ROUTING_CONTENT_VERSION } = await import("../constants.js");
        const versions = await Promise.all(
          eligible.map(async (r) => {
            try {
              return (await r.writtenRoutingVersion?.()) ?? null;
            } catch {
              return null;
            }
          })
        );

        if (versions.every((v) => v === null)) return "absent";
        if (versions.some((v) => v === null || v < ROUTING_CONTENT_VERSION)) return "stale";
        return "current";
      },

      async apply(ctx): Promise<void> {
        const eligible = ctx.installed.filter((r) => r.routing && r.writeModelRouting);
        if (eligible.length === 0) return;

        const { loadRoutingConfig } = await import("../rules/model-routing-config.js");
        const resolved = await loadRoutingConfig();
        for (const warning of resolved.warnings) console.warn(`Warning: ${warning}`);

        const { getModelRoutingSection } = await import("../rules/model-routing.js");
        for (const registrar of eligible) {
          try {
            await registrar.writeModelRouting!(await getModelRoutingSection(registrar, resolved));
          } catch (e: any) {
            console.warn(
              `Warning: Failed to write model-routing guidance for ${registrar.name}: ${e.message}`
            );
          }
        }
      },

      async remove(ctx): Promise<void> {
        const { removeSection } = await import("../rules/section-marker.js");
        const { ROUTING_SECTION_ID } = await import("../registrars/routing-section.js");
        for (const registrar of ctx.installed) {
          const path = registrar.rulesFilePath?.();
          if (path) await removeSection(path, ROUTING_SECTION_ID);
        }
      },
    },

    hookUnit({
      id: "hooks:routing",
      label: "Routing hooks",
      description: "SessionStart reminder of the routing rules (Claude Code only)",
      probe: "project-brain routing-rules",
      strictOf: (ctx) => ctx.hookStrict.routing,
      load: async () => {
        const m = await import("../hooks/claude-settings.js");
        return { upsert: m.upsertRoutingHooks, remove: m.removeRoutingHooks };
      },
    }),

    hookUnit({
      id: "hooks:worktree",
      label: "Worktree hooks",
      description: "worktree identity on session start, index cleanup on removal",
      probe: "project-brain worktree-hook session",
      strictOf: (ctx) => ctx.hookStrict.worktree,
      load: async () => {
        const m = await import("../hooks/claude-settings.js");
        return { upsert: m.upsertWorktreeHooks, remove: m.removeWorktreeHooks };
      },
    }),
  ];
}
