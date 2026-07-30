import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import skillMd from "../../templates/skills/brain-audit/SKILL.md" with { type: "text" };
import okfSkillMd from "../../templates/skills/brain-okf/SKILL.md" with { type: "text" };

// A. Product & intent
import functional from "../../templates/skills/brain-audit/references/functional.md" with { type: "text" };
import product from "../../templates/skills/brain-audit/references/product.md" with { type: "text" };
import goal from "../../templates/skills/brain-audit/references/goal.md" with { type: "text" };
import future from "../../templates/skills/brain-audit/references/future.md" with { type: "text" };
// B. Wiring & reachability
import reachability from "../../templates/skills/brain-audit/references/reachability.md" with { type: "text" };
import flowIntegrity from "../../templates/skills/brain-audit/references/flow-integrity.md" with { type: "text" };
// C. Technical layers
import backend from "../../templates/skills/brain-audit/references/backend.md" with { type: "text" };
import api from "../../templates/skills/brain-audit/references/api.md" with { type: "text" };
import frontend from "../../templates/skills/brain-audit/references/frontend.md" with { type: "text" };
import accessibility from "../../templates/skills/brain-audit/references/accessibility.md" with { type: "text" };
import mobile from "../../templates/skills/brain-audit/references/mobile.md" with { type: "text" };
import database from "../../templates/skills/brain-audit/references/database.md" with { type: "text" };
import ai from "../../templates/skills/brain-audit/references/ai.md" with { type: "text" };
// D. Execution quality
import performance from "../../templates/skills/brain-audit/references/performance.md" with { type: "text" };
import scalability from "../../templates/skills/brain-audit/references/scalability.md" with { type: "text" };
import concurrency from "../../templates/skills/brain-audit/references/concurrency.md" with { type: "text" };
import failure from "../../templates/skills/brain-audit/references/failure.md" with { type: "text" };
import complexity from "../../templates/skills/brain-audit/references/complexity.md" with { type: "text" };
import consistency from "../../templates/skills/brain-audit/references/consistency.md" with { type: "text" };
// E. Security & data
import security from "../../templates/skills/brain-audit/references/security.md" with { type: "text" };
import abuse from "../../templates/skills/brain-audit/references/abuse.md" with { type: "text" };
import privacy from "../../templates/skills/brain-audit/references/privacy.md" with { type: "text" };
// F. Delivery & operation
import devops from "../../templates/skills/brain-audit/references/devops.md" with { type: "text" };
import infrastructure from "../../templates/skills/brain-audit/references/infrastructure.md" with { type: "text" };
import observability from "../../templates/skills/brain-audit/references/observability.md" with { type: "text" };
import packaging from "../../templates/skills/brain-audit/references/packaging.md" with { type: "text" };
import dependenciesLicensing from "../../templates/skills/brain-audit/references/dependencies-licensing.md" with { type: "text" };
import versioningCompatibility from "../../templates/skills/brain-audit/references/versioning-compatibility.md" with { type: "text" };
import cost from "../../templates/skills/brain-audit/references/cost.md" with { type: "text" };
// G. Verification & knowledge
import testing from "../../templates/skills/brain-audit/references/testing.md" with { type: "text" };
import documentation from "../../templates/skills/brain-audit/references/documentation.md" with { type: "text" };
import i18n from "../../templates/skills/brain-audit/references/i18n.md" with { type: "text" };
import contractDrift from "../../templates/skills/brain-audit/references/contract-drift.md" with { type: "text" };
// H. Meta
import promptSpecGap from "../../templates/skills/brain-audit/references/prompt-spec-gap.md" with { type: "text" };

/**
 * Relative path → embedded content.
 *
 * Embedded at build time (`with { type: "text" }`) rather than read from
 * `templates/` at runtime: under `bun build --compile` — how the published
 * binary ships — `import.meta.dir` resolves to a virtual embedded path with no
 * relative traversal back to a real `templates/` directory, so every load
 * fails. That is exactly the bug 56af699 fixed for the other three templates;
 * a recursive `cp` here would reintroduce it.
 *
 * Hand-maintained on purpose. The drift risk (a reference file added to
 * `templates/` but never imported ⇒ silently missing from every install) is
 * closed by the parity assertion in tests/rules/skills.test.ts, which is
 * cheaper than codegen and fails loudly.
 */
export const BRAIN_AUDIT_FILES: Record<string, string> = {
  "SKILL.md": skillMd,
  "references/abuse.md": abuse,
  "references/accessibility.md": accessibility,
  "references/ai.md": ai,
  "references/api.md": api,
  "references/backend.md": backend,
  "references/complexity.md": complexity,
  "references/concurrency.md": concurrency,
  "references/consistency.md": consistency,
  "references/contract-drift.md": contractDrift,
  "references/cost.md": cost,
  "references/database.md": database,
  "references/dependencies-licensing.md": dependenciesLicensing,
  "references/devops.md": devops,
  "references/documentation.md": documentation,
  "references/failure.md": failure,
  "references/flow-integrity.md": flowIntegrity,
  "references/frontend.md": frontend,
  "references/functional.md": functional,
  "references/future.md": future,
  "references/goal.md": goal,
  "references/i18n.md": i18n,
  "references/infrastructure.md": infrastructure,
  "references/mobile.md": mobile,
  "references/observability.md": observability,
  "references/packaging.md": packaging,
  "references/performance.md": performance,
  "references/privacy.md": privacy,
  "references/product.md": product,
  "references/prompt-spec-gap.md": promptSpecGap,
  "references/reachability.md": reachability,
  "references/scalability.md": scalability,
  "references/security.md": security,
  "references/testing.md": testing,
  "references/versioning-compatibility.md": versioningCompatibility,
};

/**
 * brain-okf — how to write an Open Knowledge Format concept.
 *
 * Single file on purpose. brain-audit needs `references/` because it gates 34
 * independent modules and loading all of them is the cost it exists to avoid;
 * brain-okf is one coherent task, so splitting it would add indirection with
 * nothing to defer.
 */
export const BRAIN_OKF_FILES: Record<string, string> = {
  "SKILL.md": okfSkillMd,
};

/**
 * Every skill setup installs, keyed by the directory name it occupies inside a
 * skills root. Ownership is proven per skill directory, so a user's
 * hand-written `brain-okf/` is left alone even while `brain-audit/` upgrades.
 */
export const SKILL_MANIFESTS: Record<string, Record<string, string>> = {
  "brain-audit": BRAIN_AUDIT_FILES,
  "brain-okf": BRAIN_OKF_FILES,
};

/**
 * Ownership marker written into SKILL.md's frontmatter. Only files
 * project-brain produced carry it — a hand-written skill never will, even one
 * that copied our `author` field.
 */
export const GENERATOR_MARKER = "generator: project-brain";

/**
 * Tools that read shared skills from `~/.agents/skills/`.
 *
 * Verified against vendor docs on 2026-07-29 — all six read that root as the
 * cross-agent interoperability path, each in addition to its own native one:
 *
 *   Cursor      cursor.com/docs/skills            (also ~/.cursor/skills)
 *   Gemini CLI  gemini-cli docs/cli/skills.md     (also ~/.gemini/skills; .agents wins on name clash)
 *   Zed         zed.dev/docs/ai/skills            (flat layout only — direct children of the root)
 *   VS Code     code.visualstudio.com/docs/agent-customization/agent-skills  (also ~/.copilot/skills)
 *   Opencode    opencode.ai/docs/skills           (also ~/.config/opencode/skills)
 *   Windsurf    docs.windsurf.com → docs.devin.ai/desktop/cascade/skills     (also ~/.codeium/windsurf/skills)
 *
 * Zed's flat-layout rule constrains only where a skill sits, not what it
 * contains: "Skills must be direct children of the skills root. Nested folders
 * like ~/.agents/skills/group/my-skill/ are not discovered." A skill's own
 * `references/`, `scripts/` and `assets/` subdirectories are documented as
 * supported, so brain-audit/references/*.md is fine — but brain-audit/ must
 * never be moved under a grouping directory.
 */
const AGENTS_SKILLS_TOOLS = new Set([
  "Cursor",
  "Gemini CLI",
  "Windsurf",
  "Zed",
  "VS Code",
  "Opencode",
]);

/** Map registered tool names to deduped skill target directories. */
export function getSkillTargetDirs(registeredTools: string[]): string[] {
  const dirs = new Set<string>();
  for (const tool of registeredTools) {
    if (tool === "Claude Code") dirs.add(join(homedir(), ".claude", "skills"));
    else if (tool === "Codex") dirs.add(join(homedir(), ".codex", "skills"));
    else if (AGENTS_SKILLS_TOOLS.has(tool)) dirs.add(join(homedir(), ".agents", "skills"));
  }
  return [...dirs];
}

export type Ownership = "absent" | "ours" | "foreign" | "unreadable";

export interface SkippedTarget {
  /** Absolute path of the brain-audit directory that was left untouched. */
  dir: string;
  reason: Ownership;
}

export interface InstallResult {
  /** brain-audit directories actually written. */
  written: string[];
  /** Targets left untouched because ownership could not be proven. */
  skipped: SkippedTarget[];
}

/**
 * Decide whether `<dir>/brain-audit/` is safe to overwrite.
 *
 * The skills root belongs to the user, not to project-brain — it is shared
 * with every skill they hand-wrote. `unreadable` fails closed on purpose: a
 * permission error or a half-written directory is precisely when a blind
 * overwrite does the most damage.
 */
export async function inspectOwnership(skillDir: string): Promise<Ownership> {
  if (!existsSync(skillDir)) return "absent";
  try {
    const existing = await readFile(join(skillDir, "SKILL.md"), "utf8");
    return existing.includes(GENERATOR_MARKER) ? "ours" : "foreign";
  } catch {
    return "unreadable";
  }
}

/**
 * Write every embedded file into `<dir>/brain-audit/`, creating subdirectories.
 *
 * Ownership is checked once per target BEFORE any write to that target, so a
 * foreign directory is never partially clobbered. A skipped target is not an
 * error: the remaining targets still install and setup continues.
 */
export async function installSkill(targetDirs: string[]): Promise<InstallResult> {
  const written: string[] = [];
  const skipped: SkippedTarget[] = [];

  for (const dir of targetDirs) {
    for (const [name, manifest] of Object.entries(SKILL_MANIFESTS)) {
      const skillDir = join(dir, name);
      const ownership = await inspectOwnership(skillDir);
      if (ownership !== "absent" && ownership !== "ours") {
        skipped.push({ dir: skillDir, reason: ownership });
        continue;
      }

      for (const [rel, content] of Object.entries(manifest)) {
        const dest = join(skillDir, rel);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, content, "utf8");
      }
      written.push(skillDir);
    }
  }

  return { written, skipped };
}
