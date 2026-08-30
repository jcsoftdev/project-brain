import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import skillMd from "../../templates/skills/brain-audit/SKILL.md" with { type: "text" };
import okfSkillMd from "../../templates/skills/brain-okf/SKILL.md" with { type: "text" };
import commitSkillMd from "../../templates/skills/brain-commit/SKILL.md" with { type: "text" };

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
import designSystem from "../../templates/skills/brain-audit/references/design-system.md" with { type: "text" };
import visualDesign from "../../templates/skills/brain-audit/references/visual-design.md" with { type: "text" };
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
// I. Correctness primitives
import typeSafety from "../../templates/skills/brain-audit/references/type-safety.md" with { type: "text" };
import stateModel from "../../templates/skills/brain-audit/references/state-model.md" with { type: "text" };
import crossSurfaceParity from "../../templates/skills/brain-audit/references/cross-surface-parity.md" with { type: "text" };
import temporal from "../../templates/skills/brain-audit/references/temporal.md" with { type: "text" };
import numeric from "../../templates/skills/brain-audit/references/numeric.md" with { type: "text" };
import idempotency from "../../templates/skills/brain-audit/references/idempotency.md" with { type: "text" };
import multiTenancy from "../../templates/skills/brain-audit/references/multi-tenancy.md" with { type: "text" };
import featureFlags from "../../templates/skills/brain-audit/references/feature-flags.md" with { type: "text" };
import toolingBaseline from "../../templates/skills/brain-audit/references/tooling-baseline.md" with { type: "text" };
import runtime from "../../templates/skills/brain-audit/references/runtime.md" with { type: "text" };
// J. Provenance and reach
import supplyChain from "../../templates/skills/brain-audit/references/supply-chain.md" with { type: "text" };
import repoHistory from "../../templates/skills/brain-audit/references/repo-history.md" with { type: "text" };
import webMetadata from "../../templates/skills/brain-audit/references/web-metadata.md" with { type: "text" };
import analytics from "../../templates/skills/brain-audit/references/analytics.md" with { type: "text" };

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
  "references/analytics.md": analytics,
  "references/api.md": api,
  "references/backend.md": backend,
  "references/complexity.md": complexity,
  "references/concurrency.md": concurrency,
  "references/consistency.md": consistency,
  "references/contract-drift.md": contractDrift,
  "references/cost.md": cost,
  "references/cross-surface-parity.md": crossSurfaceParity,
  "references/database.md": database,
  "references/dependencies-licensing.md": dependenciesLicensing,
  "references/design-system.md": designSystem,
  "references/devops.md": devops,
  "references/documentation.md": documentation,
  "references/failure.md": failure,
  "references/feature-flags.md": featureFlags,
  "references/flow-integrity.md": flowIntegrity,
  "references/frontend.md": frontend,
  "references/functional.md": functional,
  "references/future.md": future,
  "references/goal.md": goal,
  "references/i18n.md": i18n,
  "references/idempotency.md": idempotency,
  "references/infrastructure.md": infrastructure,
  "references/mobile.md": mobile,
  "references/multi-tenancy.md": multiTenancy,
  "references/numeric.md": numeric,
  "references/observability.md": observability,
  "references/packaging.md": packaging,
  "references/performance.md": performance,
  "references/privacy.md": privacy,
  "references/product.md": product,
  "references/prompt-spec-gap.md": promptSpecGap,
  "references/reachability.md": reachability,
  "references/repo-history.md": repoHistory,
  "references/runtime.md": runtime,
  "references/scalability.md": scalability,
  "references/security.md": security,
  "references/state-model.md": stateModel,
  "references/supply-chain.md": supplyChain,
  "references/temporal.md": temporal,
  "references/testing.md": testing,
  "references/tooling-baseline.md": toolingBaseline,
  "references/type-safety.md": typeSafety,
  "references/versioning-compatibility.md": versioningCompatibility,
  "references/visual-design.md": visualDesign,
  "references/web-metadata.md": webMetadata,
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
 * brain-commit — write the commit message this repository would have written.
 *
 * Single file, for brain-okf's reason: one coherent task with nothing to defer.
 *
 * The convention lives in `git log`, not in this file. Shipping a fixed style
 * would be wrong in every repo that chose the other one — and both are common
 * enough that a guess is a coin flip. Detection is the feature.
 */
export const BRAIN_COMMIT_FILES: Record<string, string> = {
  "SKILL.md": commitSkillMd,
};

/**
 * Every skill setup installs, keyed by the directory name it occupies inside a
 * skills root. Ownership is proven per skill directory, so a user's
 * hand-written `brain-okf/` is left alone even while `brain-audit/` upgrades.
 */
export const SKILL_MANIFESTS: Record<string, Record<string, string>> = {
  "brain-audit": BRAIN_AUDIT_FILES,
  "brain-commit": BRAIN_COMMIT_FILES,
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

/**
 * Filename of the per-skill content stamp, written inside each installed skill
 * directory. Dot-prefixed so hosts scanning for `SKILL.md` skip it.
 */
export const STAMP_FILE = ".project-brain-stamp";

/**
 * Fingerprint of every byte this build ships, across every skill.
 *
 * Stamped over the WHOLE manifest rather than SKILL.md alone: Work Unit 2
 * rewrote 31 reference files without touching brain-audit's gate table, so a
 * SKILL.md-only comparison would have declared that release already installed.
 *
 * Computed once at import from strings already resident in the binary, so it
 * costs nothing at runtime and needs no human to remember a version bump.
 */
export const MANIFEST_STAMP: string = (() => {
  const parts: string[] = [];
  for (const name of Object.keys(SKILL_MANIFESTS).sort()) {
    for (const rel of Object.keys(SKILL_MANIFESTS[name]).sort()) {
      parts.push(`${name}/${rel} ${SKILL_MANIFESTS[name][rel]}`);
    }
  }
  return Bun.hash(parts.join("")).toString(16);
})();

/**
 * Every skills root project-brain can install into, regardless of which tools
 * are currently detected.
 *
 * Safe to hand to `refreshStaleSkills` unconditionally: it only touches
 * directories that already exist, so listing a root no tool uses is a no-op.
 * Detection is deliberately avoided here — a tool uninstalled after setup ran
 * would otherwise leave its skills frozen at whatever version was current then.
 */
export function knownSkillRoots(): string[] {
  const home = homedir();
  return [
    join(home, ".claude", "skills"),
    join(home, ".codex", "skills"),
    join(home, ".agents", "skills"),
  ];
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
  /** Files this generator wrote in a previous release and has now dropped. */
  removed: string[];
}

/**
 * Stamp payload: this build's fingerprint, then every relative path it wrote.
 *
 * The file list is what makes pruning possible without guessing. Writing a
 * manifest and never recording it means the next release can add files and
 * rewrite files but can never *remove* one — and a directory refreshed by an
 * older build then carries that build's SKILL.md beside reference files it has
 * never heard of. brain-audit's gate table is the index of its own modules, so
 * an orphaned reference file is a module no gate can enable: it ships, it is
 * never loaded, and nothing on disk says why.
 *
 * A legacy single-line stamp parses to an empty file list, which disables
 * pruning for that directory. That is the safe direction: we only ever delete
 * a path we can prove a previous version of ourselves wrote.
 */
export interface Stamp {
  hash: string;
  files: string[];
}

export function parseStamp(raw: string): Stamp {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  return { hash: lines[0] ?? "", files: lines.slice(1) };
}

function renderStamp(manifest: Record<string, string>): string {
  return [MANIFEST_STAMP, ...Object.keys(manifest).sort()].join("\n") + "\n";
}

async function readStamp(skillDir: string): Promise<Stamp> {
  try {
    return parseStamp(await readFile(join(skillDir, STAMP_FILE), "utf8"));
  } catch {
    // Missing stamp means this copy predates stamping — treat as stale, and
    // prune nothing, because we have no record of what we put there.
    return { hash: "", files: [] };
  }
}

/**
 * Delete files a previous stamp claims we wrote and this manifest no longer
 * ships. Never touches a path we did not record — a hand-written
 * `references/custom.md` is the user's, and it survives every refresh.
 */
async function pruneOrphans(
  skillDir: string,
  recorded: string[],
  manifest: Record<string, string>
): Promise<string[]> {
  const shipped = new Set(Object.keys(manifest));
  const removed: string[] = [];
  for (const rel of recorded) {
    if (shipped.has(rel)) continue;
    // A stamp is a file we wrote, but it is also a file on disk that an
    // attacker or a bad merge could have edited. Refuse to follow it out of
    // the directory it describes.
    if (rel.startsWith("/") || rel.split("/").includes("..")) continue;
    const dest = join(skillDir, rel);
    try {
      await rm(dest, { force: true });
      removed.push(dest);
    } catch {
      // A read-only or already-vanished file must not break the refresh.
    }
  }
  return removed;
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
  const removed: string[] = [];

  for (const dir of targetDirs) {
    for (const [name, manifest] of Object.entries(SKILL_MANIFESTS)) {
      const skillDir = join(dir, name);
      const ownership = await inspectOwnership(skillDir);
      if (ownership !== "absent" && ownership !== "ours") {
        skipped.push({ dir: skillDir, reason: ownership });
        continue;
      }

      const previous = ownership === "ours" ? await readStamp(skillDir) : { hash: "", files: [] };

      for (const [rel, content] of Object.entries(manifest)) {
        const dest = join(skillDir, rel);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, content, "utf8");
      }
      removed.push(...(await pruneOrphans(skillDir, previous.files, manifest)));
      await writeFile(join(skillDir, STAMP_FILE), renderStamp(manifest), "utf8");
      written.push(skillDir);
    }
  }

  return { written, skipped, removed };
}

export interface RefreshResult {
  /** Skill directories rewritten because their stamp was stale or missing. */
  refreshed: string[];
  /** Skill directories created because this build ships a skill the root lacked. */
  added: string[];
  /** Skill directories already carrying this build's stamp. */
  upToDate: string[];
  /** Existing directories left alone because ownership could not be proven. */
  skipped: SkippedTarget[];
  /** Files a previous stamp recorded that this build no longer ships. */
  removed: string[];
}

/**
 * Has setup ever populated this root?
 *
 * The question gates directory creation, so it is answered by ownership, not by
 * existence: a root full of hand-written skills and none of ours is a root we
 * were never invited into.
 */
async function rootIsAdopted(dir: string): Promise<boolean> {
  for (const name of Object.keys(SKILL_MANIFESTS)) {
    if ((await inspectOwnership(join(dir, name))) === "ours") return true;
  }
  return false;
}

/**
 * Bring already-installed skills up to this build's content, and complete the
 * set in any root setup has already adopted.
 *
 * This closes a path that was built and never walked. The ownership marker
 * exists so setup can overwrite its own directories, but `update` only spawns
 * the package manager — nothing re-installed skills, so an upgraded binary
 * shipped new skill content that never reached disk. Worse, it is not fixable by
 * chaining `update` into `setup`: someone who upgrades with `brew upgrade`, or by
 * dropping in a binary, never runs `update` at all. Comparing content on disk
 * against content in the binary is the only check that works for every channel.
 *
 * **Never creates a skills ROOT.** Adopting `~/.claude/skills` is setup's job,
 * with a prompt — an absent or unadopted root is left completely alone.
 *
 * Within an adopted root it does create missing skill DIRECTORIES, and that is
 * a deliberate widening of the original rule. Refreshing content but not adding
 * skills reopened the same bug one level up: a release that ships a NEW skill
 * reached nobody who already ran setup, silently, because "refresh" only ever
 * looked at directories that existed. Every upgrade channel hit it.
 *
 * The cost, stated plainly: a skill deleted on purpose comes back on the next
 * command. Adoption is the mitigation — we only complete roots that already
 * carry our marker, never one the user never opted into — but inside such a
 * root, "missing" and "unwanted" are indistinguishable on disk. Someone who
 * wants a skill gone should decline the root, not delete one directory.
 */
export async function refreshStaleSkills(targetDirs: string[]): Promise<RefreshResult> {
  const refreshed: string[] = [];
  const added: string[] = [];
  const upToDate: string[] = [];
  const skipped: SkippedTarget[] = [];
  const removed: string[] = [];

  for (const dir of targetDirs) {
    const adopted = await rootIsAdopted(dir);

    for (const [name, manifest] of Object.entries(SKILL_MANIFESTS)) {
      const skillDir = join(dir, name);

      if (!existsSync(skillDir)) {
        // A root we were never invited into is not ours to populate.
        if (!adopted) continue;
        try {
          for (const [rel, content] of Object.entries(manifest)) {
            const dest = join(skillDir, rel);
            await mkdir(dirname(dest), { recursive: true });
            await writeFile(dest, content, "utf8");
          }
          await writeFile(join(skillDir, STAMP_FILE), renderStamp(manifest), "utf8");
          added.push(skillDir);
        } catch {
          // Same rule as below: a read-only or vanished directory must not
          // break the command that happened to trigger this check.
        }
        continue;
      }

      const ownership = await inspectOwnership(skillDir);
      if (ownership !== "ours") {
        skipped.push({ dir: skillDir, reason: ownership });
        continue;
      }

      const previous = await readStamp(skillDir);
      if (previous.hash === MANIFEST_STAMP) {
        upToDate.push(skillDir);
        continue;
      }

      try {
        for (const [rel, content] of Object.entries(manifest)) {
          const dest = join(skillDir, rel);
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, content, "utf8");
        }
        removed.push(...(await pruneOrphans(skillDir, previous.files, manifest)));
        await writeFile(join(skillDir, STAMP_FILE), renderStamp(manifest), "utf8");
        refreshed.push(skillDir);
      } catch {
        // A read-only or vanished directory must not break the command that
        // happened to trigger this check.
      }
    }
  }

  return { refreshed, added, upToDate, skipped, removed };
}
