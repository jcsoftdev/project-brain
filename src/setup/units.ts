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
