/**
 * brain-audit skill distribution.
 *
 * Two things are load-bearing here and both have already gone wrong once:
 *
 * 1. The manifest is hand-maintained. A reference file added under
 *    templates/skills/brain-audit/ but never imported ships to nobody,
 *    silently. Parity is asserted, not assumed.
 * 2. The install target belongs to the USER, not to project-brain. The
 *    author's own ~/.claude/skills/ holds 30 hand-written skill directories.
 *    installSkill writes only where it can prove ownership — see design §7.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  BRAIN_AUDIT_FILES,
  GENERATOR_MARKER,
  MANIFEST_STAMP,
  SKILL_MANIFESTS,
  STAMP_FILE,
  getSkillTargetDirs,
  inspectOwnership,
  installSkill,
  parseStamp,
  refreshStaleSkills,
} from "../../src/rules/skills.js";

describe("getSkillTargetDirs", () => {
  it("returns [] for no registered tools", () => {
    expect(getSkillTargetDirs([])).toEqual([]);
  });

  it("maps Claude Code to ~/.claude/skills", () => {
    expect(getSkillTargetDirs(["Claude Code"])).toEqual([join(homedir(), ".claude", "skills")]);
  });

  it("maps Codex to ~/.codex/skills", () => {
    expect(getSkillTargetDirs(["Codex"])).toEqual([join(homedir(), ".codex", "skills")]);
  });

  /** All six verified against vendor docs 2026-07-29 — see AGENTS_SKILLS_TOOLS. */
  it("dedupes the six ~/.agents/skills tools to a single target", () => {
    const dirs = getSkillTargetDirs([
      "Cursor",
      "Gemini CLI",
      "Windsurf",
      "Zed",
      "VS Code",
      "Opencode",
    ]);
    expect(dirs).toEqual([join(homedir(), ".agents", "skills")]);
  });

  it("ignores unknown tool names", () => {
    expect(getSkillTargetDirs(["Emacs"])).toEqual([]);
  });

  it("returns all three roots when tools from each group are registered", () => {
    const dirs = getSkillTargetDirs(["Claude Code", "Codex", "Cursor"]);
    expect(dirs.sort()).toEqual(
      [
        join(homedir(), ".agents", "skills"),
        join(homedir(), ".claude", "skills"),
        join(homedir(), ".codex", "skills"),
      ].sort()
    );
  });
});

describe("BRAIN_AUDIT_FILES", () => {
  it("contains SKILL.md with real frontmatter", () => {
    expect(BRAIN_AUDIT_FILES["SKILL.md"]).toContain("name: brain-audit");
  });

  it("has non-empty content for every entry", () => {
    for (const [rel, content] of Object.entries(BRAIN_AUDIT_FILES)) {
      expect(content.length, `${rel} is empty`).toBeGreaterThan(0);
    }
  });

  it("has a manifest entry for every file under templates/skills/brain-audit", async () => {
    const root = join(import.meta.dir, "../../templates/skills/brain-audit");
    const refs = await readdir(join(root, "references"));
    const onDisk = ["SKILL.md", ...refs.map((f) => `references/${f}`)].sort();
    expect(Object.keys(BRAIN_AUDIT_FILES).sort()).toEqual(onDisk);
  });
});

/**
 * The manifest is hand-maintained, so a new skill directory added under
 * templates/skills/ but never registered ships to nobody — silently, and with
 * every test still green. This is the same drift brain-audit's parity test
 * guards, one level up: skill directories rather than reference files.
 */
describe("SKILL_MANIFESTS registry parity", () => {
  it("registers every skill directory under templates/skills", async () => {
    const root = join(import.meta.dir, "../../templates/skills");
    const onDisk = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(Object.keys(SKILL_MANIFESTS).sort()).toEqual(onDisk);
  });

  it("every registered skill carries a SKILL.md with the ownership marker", () => {
    for (const [name, manifest] of Object.entries(SKILL_MANIFESTS)) {
      expect(manifest["SKILL.md"], `${name} has no SKILL.md`).toBeDefined();
      expect(manifest["SKILL.md"], `${name} lacks the marker`).toContain(GENERATOR_MARKER);
      expect(manifest["SKILL.md"], `${name} frontmatter name mismatch`).toContain(`name: ${name}`);
    }
  });

  it("every manifest entry matches its file on disk", async () => {
    for (const [name, manifest] of Object.entries(SKILL_MANIFESTS)) {
      for (const rel of Object.keys(manifest)) {
        const onDisk = await readFile(
          join(import.meta.dir, "../../templates/skills", name, rel),
          "utf8"
        );
        expect(onDisk, `${name}/${rel} drifted from the manifest`).toBe(manifest[rel]);
      }
    }
  });
});

describe("installSkill", () => {
  let dirA: string;
  let dirB: string;
  beforeEach(async () => {
    dirA = await mkdtemp(join(tmpdir(), "pb-skill-a-"));
    dirB = await mkdtemp(join(tmpdir(), "pb-skill-b-"));
  });
  afterEach(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it("writes every manifest entry under <dir>/brain-audit/", async () => {
    await installSkill([dirA]);
    for (const rel of Object.keys(BRAIN_AUDIT_FILES)) {
      const content = await readFile(join(dirA, "brain-audit", rel), "utf8");
      expect(content).toBe(BRAIN_AUDIT_FILES[rel]);
    }
  });

  it("creates nested reference subdirectories", async () => {
    await installSkill([dirA]);
    const refs = await readdir(join(dirA, "brain-audit", "references"));
    expect(refs.length).toBeGreaterThan(0);
  });

  it("writes to every target directory", async () => {
    await installSkill([dirA, dirB]);
    expect(await readFile(join(dirB, "brain-audit", "SKILL.md"), "utf8")).toContain("brain-audit");
  });

  it("overwrites cleanly on reinstall (the upgrade path)", async () => {
    await installSkill([dirA]);
    await installSkill([dirA]);
    expect(await readFile(join(dirA, "brain-audit", "SKILL.md"), "utf8")).toBe(
      BRAIN_AUDIT_FILES["SKILL.md"]
    );
  });

  it("reports one written directory per skill per target", async () => {
    const { written, skipped } = await installSkill([dirA]);
    expect(written.sort()).toEqual(
      Object.keys(SKILL_MANIFESTS)
        .map((name) => join(dirA, name))
        .sort()
    );
    expect(skipped).toEqual([]);
  });

  it("installs every skill in the registry, not just the first", async () => {
    await installSkill([dirA]);
    for (const [name, manifest] of Object.entries(SKILL_MANIFESTS)) {
      for (const rel of Object.keys(manifest)) {
        const content = await readFile(join(dirA, name, rel), "utf8");
        expect(content, `${name}/${rel}`).toBe(manifest[rel]);
      }
    }
  });
});

/**
 * Anti-drift guard for v1's Defect 1: the gate table and the reference list
 * both claimed 24 modules and were different sets. `Performance` and
 * `Observability` were documented but no gate could ever enable them;
 * `Accessibility` and `API` were enabled by gates but pointed at nothing.
 *
 * Both directions are asserted here, because each catches a different bug:
 * a gate with no file breaks at runtime, a file with no gate is dead content.
 *
 * Work Unit 2 empties DEFERRED_TO_WORK_UNIT_2 one module at a time. When it
 * reaches [] the guard is fully closed and every gate has real bytes behind it.
 */
/**
 * EMPTY as of Work Unit 2 — every one of the 51 gated modules now has real
 * bytes behind it. The guard is fully closed: adding a gate row without a
 * reference file, or a reference file without a gate row, now fails.
 *
 * Do not re-populate this to make a failing build pass. A non-empty list means
 * SKILL.md promises a module that ships to nobody.
 */
const DEFERRED_TO_WORK_UNIT_2: string[] = [];

/**
 * Pull the reference filenames out of SKILL.md's Decision Gates table.
 *
 * The table carries the exact filename in its own column, so this reads them
 * literally instead of slugifying module names — nothing has to guess that
 * "Prompt/Spec Gap" becomes "prompt-spec-gap". Scoped to the section so a
 * filename mentioned elsewhere in the doc cannot leak in.
 */
function extractGateReferences(skill: string): string[] {
  const start = skill.indexOf("## Decision Gates");
  expect(start, "SKILL.md has no '## Decision Gates' section").toBeGreaterThan(-1);
  const rest = skill.slice(start);
  const end = rest.indexOf("\n## ", 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  return [...section.matchAll(/`([a-z0-9-]+\.md)`/g)].map((m) => m[1]);
}

describe("gate table parity (guards v1 Defect 1)", () => {
  const gateRefs = extractGateReferences(BRAIN_AUDIT_FILES["SKILL.md"]);

  it("names all 52 modules, with no duplicates", () => {
    expect(gateRefs.length).toBe(52);
    expect(new Set(gateRefs).size).toBe(52);
  });

  it("every gate reference either ships or is explicitly deferred", () => {
    const shipped = new Set(
      Object.keys(BRAIN_AUDIT_FILES)
        .filter((k) => k.startsWith("references/"))
        .map((k) => k.slice("references/".length))
    );
    const missing = gateRefs.filter((r) => !shipped.has(r)).sort();
    expect(missing, `gate table names modules with no reference file: ${missing.join(", ")}`).toEqual(
      [...DEFERRED_TO_WORK_UNIT_2].sort()
    );
  });

  /**
   * The inverse, and the half v1 got wrong twice: a reference file no gate can
   * enable is content that ships to every user and can never run.
   */
  it("every shipped reference file is reachable from a gate", () => {
    const gated = new Set(gateRefs);
    const orphans = Object.keys(BRAIN_AUDIT_FILES)
      .filter((k) => k.startsWith("references/"))
      .map((k) => k.slice("references/".length))
      .filter((f) => !gated.has(f));
    expect(orphans, `reference files no gate enables: ${orphans.join(", ")}`).toEqual([]);
  });

  it("deferred list stays honest — nothing in it is already shipped", () => {
    const shipped = new Set(
      Object.keys(BRAIN_AUDIT_FILES)
        .filter((k) => k.startsWith("references/"))
        .map((k) => k.slice("references/".length))
    );
    expect(DEFERRED_TO_WORK_UNIT_2.filter((f) => shipped.has(f))).toEqual([]);
  });
});

describe("ownership guard (design §7 — Defect 3)", () => {
  let dirA: string;
  let dirB: string;
  beforeEach(async () => {
    dirA = await mkdtemp(join(tmpdir(), "pb-own-a-"));
    dirB = await mkdtemp(join(tmpdir(), "pb-own-b-"));
  });
  afterEach(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  /** The marker has to survive into the shipped bytes, or every upgrade skips. */
  it("SKILL.md actually carries GENERATOR_MARKER", () => {
    expect(BRAIN_AUDIT_FILES["SKILL.md"]).toContain(GENERATOR_MARKER);
  });

  it("reports absent for a path that does not exist", async () => {
    expect(await inspectOwnership(join(dirA, "brain-audit"))).toBe("absent");
  });

  it("reports ours after we installed", async () => {
    await installSkill([dirA]);
    expect(await inspectOwnership(join(dirA, "brain-audit"))).toBe("ours");
  });

  it("reports foreign for a hand-written SKILL.md", async () => {
    const skillDir = join(dirA, "brain-audit");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: brain-audit\n---\nmine\n");
    expect(await inspectOwnership(skillDir)).toBe("foreign");
  });

  it("reports unreadable when the dir exists but SKILL.md does not", async () => {
    await mkdir(join(dirA, "brain-audit"), { recursive: true });
    expect(await inspectOwnership(join(dirA, "brain-audit"))).toBe("unreadable");
  });

  it("leaves a foreign directory byte-for-byte unchanged", async () => {
    const skillDir = join(dirA, "brain-audit");
    await mkdir(join(skillDir, "references"), { recursive: true });
    const mine = "---\nname: brain-audit\n---\ndo not touch\n";
    await writeFile(join(skillDir, "SKILL.md"), mine);
    await writeFile(join(skillDir, "references", "custom.md"), "mine too");

    const { written, skipped } = await installSkill([dirA]);

    expect(skipped).toEqual([{ dir: skillDir, reason: "foreign" }]);
    expect(written).not.toContain(skillDir);
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(mine);
    expect(await readFile(join(skillDir, "references", "custom.md"), "utf8")).toBe("mine too");
  });

  /**
   * Ownership is per skill DIRECTORY, not per skills root. A hand-written
   * brain-audit/ must not stop brain-okf/ from installing beside it — they are
   * independent directories that happen to share a parent the user owns.
   */
  it("a foreign skill does not block a sibling skill in the same root", async () => {
    await mkdir(join(dirA, "brain-audit"), { recursive: true });
    await writeFile(join(dirA, "brain-audit", "SKILL.md"), "hand-written");

    const { written, skipped } = await installSkill([dirA]);

    expect(skipped.map((s) => s.dir)).toEqual([join(dirA, "brain-audit")]);
    expect(written).toContain(join(dirA, "brain-okf"));
    expect(await readFile(join(dirA, "brain-audit", "SKILL.md"), "utf8")).toBe("hand-written");
  });

  it("a foreign target does not block a sibling target", async () => {
    await mkdir(join(dirA, "brain-audit"), { recursive: true });
    await writeFile(join(dirA, "brain-audit", "SKILL.md"), "hand-written");

    const { written, skipped } = await installSkill([dirA, dirB]);

    expect(skipped.map((s) => s.dir)).toEqual([join(dirA, "brain-audit")]);
    expect(written).toContain(join(dirB, "brain-audit"));
    expect(await readFile(join(dirB, "brain-audit", "SKILL.md"), "utf8")).toBe(
      BRAIN_AUDIT_FILES["SKILL.md"]
    );
  });
});

/**
 * Lazy upgrade path.
 *
 * The ownership marker was built so setup could overwrite its own skill
 * directories — and then nothing ever invoked it. `update` only spawns the
 * package manager; it never re-installs skills. So an upgraded binary shipped
 * new skill content that never reached disk.
 *
 * The stamp is over the WHOLE manifest, not just SKILL.md. Work Unit 2 changed
 * 31 reference files without touching SKILL.md's gate table — a SKILL.md-only
 * comparison would have missed the entire release.
 */
describe("refreshStaleSkills", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pb-refresh-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes a stamp alongside the skill on install", async () => {
    await installSkill([root]);
    for (const name of Object.keys(SKILL_MANIFESTS)) {
      const stamp = parseStamp(await readFile(join(root, name, STAMP_FILE), "utf8"));
      expect(stamp.hash).toBe(MANIFEST_STAMP);
      expect(stamp.files.sort()).toEqual(Object.keys(SKILL_MANIFESTS[name]).sort());
    }
  });

  it("reports up-to-date and writes nothing when the stamp matches", async () => {
    await installSkill([root]);
    const result = await refreshStaleSkills([root]);

    expect(result.refreshed).toEqual([]);
    expect(result.upToDate.sort()).toEqual(
      Object.keys(SKILL_MANIFESTS).map((n) => join(root, n)).sort()
    );
  });

  it("rewrites the skill when the stamp is stale", async () => {
    await installSkill([root]);
    const skillDir = join(root, "brain-audit");
    await writeFile(join(skillDir, STAMP_FILE), "an-older-release\n");
    // Content from that older release. It KEEPS the marker, because an older
    // release of ours wrote it — that is what makes the directory refreshable.
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: brain-audit\nmetadata:\n  ${GENERATOR_MARKER}\n---\nolder content\n`
    );

    const result = await refreshStaleSkills([root]);

    expect(result.refreshed).toContain(skillDir);
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(
      BRAIN_AUDIT_FILES["SKILL.md"]
    );
    expect(parseStamp(await readFile(join(skillDir, STAMP_FILE), "utf8")).hash).toBe(MANIFEST_STAMP);
  });

  /**
   * Documents a real limitation rather than hiding it: refresh needs the marker
   * in the INSTALLED copy. A copy whose SKILL.md lost the marker — hand-edited,
   * or shipped by a build that omitted it — is permanently unreachable by the
   * upgrade path, exactly as the marker's own comment warns. Failing closed is
   * still right: without the marker we cannot prove the directory is ours.
   */
  it("cannot refresh a copy whose SKILL.md lost the marker — and says so", async () => {
    await installSkill([root]);
    const skillDir = join(root, "brain-audit");
    await writeFile(join(skillDir, STAMP_FILE), "an-older-release\n");
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: brain-audit\n---\nno marker\n");

    const result = await refreshStaleSkills([root]);

    expect(result.refreshed).not.toContain(skillDir);
    expect(result.skipped).toEqual([{ dir: skillDir, reason: "foreign" }]);
  });

  it("treats a missing stamp as stale — it predates stamping", async () => {
    await installSkill([root]);
    const skillDir = join(root, "brain-okf");
    await rm(join(skillDir, STAMP_FILE));

    const result = await refreshStaleSkills([root]);
    expect(result.refreshed).toContain(skillDir);
  });

  /**
   * The load-bearing property. A lazy check must never start installing into a
   * root the user did not opt into — that is setup's job, with a prompt.
   *
   * "Opted in" is proven by ownership, not by the directory existing: an empty
   * root, or one holding only hand-written skills, is untouched.
   */
  it("NEVER creates anything in a root it has not already adopted", async () => {
    const result = await refreshStaleSkills([root]);

    expect(result.refreshed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.upToDate).toEqual([]);
    for (const name of Object.keys(SKILL_MANIFESTS)) {
      expect(existsSync(join(root, name)), `${name} must not be created`).toBe(false);
    }
  });

  it("does not adopt a root holding only hand-written skills", async () => {
    const foreign = join(root, "brain-audit");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "SKILL.md"), "---\nname: brain-audit\n---\nhand-written\n");

    const result = await refreshStaleSkills([root]);

    expect(result.added).toEqual([]);
    for (const name of Object.keys(SKILL_MANIFESTS)) {
      if (name === "brain-audit") continue;
      expect(existsSync(join(root, name)), `${name} must not be created`).toBe(false);
    }
  });

  /**
   * The gap this widening closes: refreshing content but never adding a
   * directory meant a release shipping a NEW skill reached nobody who had
   * already run setup — silently, through every upgrade channel. Same bug the
   * refresh itself was written for, one level up.
   */
  describe("completing an adopted root", () => {
    it("installs a skill the adopted root is missing", async () => {
      await installSkill([root]);
      const missing = join(root, "brain-commit");
      await rm(missing, { recursive: true, force: true });

      const result = await refreshStaleSkills([root]);

      expect(result.added).toEqual([missing]);
      expect(existsSync(join(missing, "SKILL.md"))).toBe(true);
      expect(parseStamp(await readFile(join(missing, STAMP_FILE), "utf8")).hash).toBe(MANIFEST_STAMP);
    });

    it("adds nothing when the adopted root is already complete", async () => {
      await installSkill([root]);
      const result = await refreshStaleSkills([root]);
      expect(result.added).toEqual([]);
    });

    it("adopts on any owned skill, not one specific name", async () => {
      await installSkill([root]);
      // Leave only brain-okf behind: adoption must not hinge on brain-audit.
      for (const name of Object.keys(SKILL_MANIFESTS)) {
        if (name !== "brain-okf") await rm(join(root, name), { recursive: true, force: true });
      }

      const result = await refreshStaleSkills([root]);

      expect(result.added.sort()).toEqual(
        Object.keys(SKILL_MANIFESTS)
          .filter((n) => n !== "brain-okf")
          .map((n) => join(root, n))
          .sort()
      );
    });
  });

  it("leaves a foreign skill directory alone even when it looks stale", async () => {
    const skillDir = join(root, "brain-audit");
    await mkdir(skillDir, { recursive: true });
    const mine = "---\nname: brain-audit\n---\nhand-written\n";
    await writeFile(join(skillDir, "SKILL.md"), mine);

    const result = await refreshStaleSkills([root]);

    expect(result.refreshed).toEqual([]);
    expect(result.skipped).toEqual([{ dir: skillDir, reason: "foreign" }]);
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(mine);
  });

  it("does not throw on an unreadable root", async () => {
    await expect(refreshStaleSkills([join(root, "nope")])).resolves.toBeDefined();
  });
});

/**
 * Pruning (guards the mixed-state bug found on 2026-08-29).
 *
 * A real ~/.claude/skills/brain-audit ended up carrying a 34-module SKILL.md
 * beside 49 reference files: an older build refreshed the directory from its
 * own manifest and had no way to remove the 15 files a newer build had left
 * there. brain-audit's gate table IS its module index, so each orphan was a
 * module no gate could enable — shipped, never loadable, and silent about it.
 *
 * The stamp records what we wrote so the next write can take it back. What we
 * never wrote is not ours to delete.
 */
describe("orphan pruning", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pb-prune-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const skillName = "brain-audit";

  it("removes a file the previous stamp recorded and this build no longer ships", async () => {
    await installSkill([root]);
    const skillDir = join(root, skillName);
    const orphan = join(skillDir, "references", "retired-module.md");

    // Stand in for an older release: a real file, recorded in a stale stamp.
    await writeFile(orphan, "# Retired\n");
    const current = parseStamp(await readFile(join(skillDir, STAMP_FILE), "utf8"));
    await writeFile(
      join(skillDir, STAMP_FILE),
      ["an-older-release", ...current.files, "references/retired-module.md"].join("\n") + "\n"
    );

    const result = await refreshStaleSkills([root]);

    expect(result.refreshed).toContain(skillDir);
    expect(existsSync(orphan)).toBe(false);
    expect(result.removed).toContain(orphan);
  });

  it("keeps a hand-written reference file the stamp never recorded", async () => {
    await installSkill([root]);
    const skillDir = join(root, skillName);
    const mine = join(skillDir, "references", "custom.md");
    await writeFile(mine, "mine");

    // Stale the stamp WITHOUT recording custom.md — it was never ours.
    const current = parseStamp(await readFile(join(skillDir, STAMP_FILE), "utf8"));
    await writeFile(
      join(skillDir, STAMP_FILE),
      ["an-older-release", ...current.files].join("\n") + "\n"
    );

    const result = await refreshStaleSkills([root]);

    expect(await readFile(mine, "utf8")).toBe("mine");
    expect(result.removed).toEqual([]);
  });

  it("prunes nothing when the stamp predates file recording", async () => {
    await installSkill([root]);
    const skillDir = join(root, skillName);
    const orphan = join(skillDir, "references", "retired-module.md");
    await writeFile(orphan, "# Retired\n");
    // Legacy format: hash only, no file list. We cannot prove we wrote
    // anything, so we delete nothing.
    await writeFile(join(skillDir, STAMP_FILE), "an-older-release\n");

    const result = await refreshStaleSkills([root]);

    expect(result.refreshed).toContain(skillDir);
    expect(existsSync(orphan)).toBe(true);
    expect(result.removed).toEqual([]);
  });

  it("refuses a recorded path that escapes the skill directory", async () => {
    await installSkill([root]);
    const skillDir = join(root, skillName);
    const outside = join(root, "not-ours.md");
    await writeFile(outside, "untouched");

    await writeFile(
      join(skillDir, STAMP_FILE),
      ["an-older-release", "../not-ours.md", "/etc/passwd"].join("\n") + "\n"
    );

    const result = await refreshStaleSkills([root]);

    expect(await readFile(outside, "utf8")).toBe("untouched");
    expect(result.removed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reference module lint — self-review layer 1 (design 2026-09-01, Part A).
// Deterministic rules over every references/*.md in the brain-audit manifest.
// A check with no probe is dead (SKILL.md step 5); a severity outside the
// contract — in the Severity guidance table or in an observation table's
// "Observed instance earns" column — or a cross-reference to a missing file
// is a wrong finding waiting to happen. These run on every `bun test` so a
// future module cannot reintroduce what the self-review removed.
// ---------------------------------------------------------------------------

const AUDIT_PROBES = [
  "search_context",
  "search_code",
  "expand_context",
  "find_symbol",
  "find_callers",
  "find_callees",
  "impact",
  "trace_path",
  "repo_map",
  "list_modules",
  "get_module",
  "get_architecture",
  "check_health",
  "sync_project",
  "Read",
];
// Real project-brain tools that are not audit probes but may be named in prose.
const OTHER_TOOLS = ["add_knowledge", "delete_knowledge", "manage_adr", "list_projects", "delete_project"];
const SEVERITIES = new Set(["Critical", "High", "Medium", "Low", "Info"]);
// Modules the references cite before they ship. Empty since Part B of the
// 2026-09-01 design landed browser.md; the honesty test below fails the moment
// a listed file ships, so it cannot go stale.
const PENDING_PART_B: string[] = [];
// Observation-bundle artefacts browser.md produces; cited by consumer modules,
// never modules themselves.
const BROWSER_ARTEFACTS = ["steps.md", "insights.md", "vitals.md", "a11y-snapshot.md", "final-state.md", "routes.md", "resource-perf.md"];

function referenceModules(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(BRAIN_AUDIT_FILES)
      .filter(([k]) => k.startsWith("references/"))
      .map(([k, v]) => [k.slice("references/".length), v])
  );
}

function section(md: string, heading: string): string | null {
  const start = md.indexOf(`\n## ${heading}`);
  if (start === -1) return null;
  const rest = md.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Decision Gates rows: module file → gate signal (empty cell inherits the row above). */
function gateSignals(skill: string): Map<string, string> {
  const gates = section(skill, "Decision Gates") ?? "";
  const out = new Map<string, string>();
  let carried = "";
  for (const line of gates.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3 || cells[0] === "Gate signal" || cells[0].startsWith("---")) continue;
    if (cells[0] !== "") carried = cells[0];
    const ref = cells[2].match(/`([a-z0-9-]+\.md)`/)?.[1];
    if (ref) out.set(ref, carried);
  }
  return out;
}

describe("reference module lint (self-review layer 1)", () => {
  const modules = referenceModules();
  const names = new Set(Object.keys(modules));
  const lines = (md: string) => md.split("\n").map((text, i) => ({ n: i + 1, text }));
  const checks = (md: string) => lines(md).filter((l) => /^\s*- \[ \]/.test(l.text));

  it("has the 52 modules the gate table names", () => {
    expect(names.size).toBe(52);
  });

  it("every check names at least one probe from the catalogue", () => {
    const probeRe = new RegExp("`(" + AUDIT_PROBES.join("|") + ")(\\([^`]*\\))?`|\\bRead\\b");
    // repo-history.md is the one module allowed to run git; its probe is the git command.
    const gitRe = /`git [a-z]/;
    const dead: string[] = [];
    for (const [name, md] of Object.entries(modules)) {
      if (name === "runtime.md") continue; // executes declared commands; the command is its probe
      if (name === "browser.md") continue; // drives a browser tool; the tool call is its probe
      const ok = (t: string) => probeRe.test(t) || (name === "repo-history.md" && gitRe.test(t));
      for (const l of checks(md)) if (!ok(l.text)) dead.push(`${name}:${l.n}`);
    }
    expect(dead, `checks naming no probe (dead per SKILL.md step 5):\n${dead.join("\n")}`).toEqual([]);
  });

  it("every probe-shaped identifier is a real project-brain tool", () => {
    const known = new Set([...AUDIT_PROBES, ...OTHER_TOOLS]);
    const shaped = /`((?:search|find|get|list|expand|trace|check|sync|repo|manage|add|delete)_[a-z_]+)(?:\([^`]*\))?`/g;
    const unknown: string[] = [];
    for (const [name, md] of Object.entries(modules)) {
      if (name === "browser.md") continue; // names browser-tool calls (list_network_requests, …), not project-brain probes
      for (const l of lines(md)) {
        for (const m of l.text.matchAll(shaped)) if (!known.has(m[1]) && !m[1].endsWith("_id")) unknown.push(`${name}:${l.n} \`${m[1]}\``);
      }
    }
    expect(unknown, `probe-shaped names not in the tool catalogue:\n${unknown.join("\n")}`).toEqual([]);
  });

  it("every Severity guidance row uses a contract severity", () => {
    const bad: string[] = [];
    for (const [name, md] of Object.entries(modules)) {
      const sev = section(md, "Severity guidance");
      if (sev === null) continue; // reported by the required-sections rule
      const offset = md.slice(0, md.indexOf(sev)).split("\n").length;
      sev.split("\n").forEach((text, i) => {
        if (!text.startsWith("|")) return;
        const cells = text.split("|").slice(1, -1).map((c) => c.trim());
        if (cells.length < 2 || cells[0] === "Situation" || cells[0].startsWith("---")) return;
        const last = cells[cells.length - 1];
        if (!SEVERITIES.has(last)) bad.push(`${name}:${offset + i} "${last}"`);
      });
    }
    expect(bad, `severity cells outside Critical|High|Medium|Low|Info:\n${bad.join("\n")}`).toEqual([]);
  });

  it("every observation-table severity cell is a single contract severity", () => {
    const bad: string[] = [];
    for (const [name, md] of Object.entries(modules)) {
      const obs = section(md, "What browser observation closes");
      if (obs === null) continue; // browser.md is not required to close its own observations
      const offset = md.slice(0, md.indexOf(obs)).split("\n").length;
      obs.split("\n").forEach((text, i) => {
        if (!text.startsWith("|")) return;
        const cells = text.split("|").slice(1, -1).map((c) => c.trim());
        if (cells.length < 2 || cells[0] === "Artefact" || cells[0].startsWith("---")) return;
        const last = cells[cells.length - 1];
        if (!SEVERITIES.has(last)) bad.push(`${name}:${offset + i} "${last}"`);
      });
    }
    expect(bad, `observation-table severity cells outside Critical|High|Medium|Low|Info:\n${bad.join("\n")}`).toEqual([]);
  });

  it("every cross-reference to a `<name>.md` points at a shipped module", () => {
    const broken: string[] = [];
    for (const [name, md] of Object.entries(modules)) {
      for (const l of lines(md)) {
        for (const m of l.text.matchAll(/`([a-z0-9-]+\.md)`/g)) {
          if (m[1] !== "SKILL.md" && !names.has(m[1]) && !PENDING_PART_B.includes(m[1]) && !BROWSER_ARTEFACTS.includes(m[1])) broken.push(`${name}:${l.n} \`${m[1]}\``);
        }
      }
    }
    expect(broken, `cross-references to files that do not ship:\n${broken.join("\n")}`).toEqual([]);
  });

  it("pending Part B list stays honest — nothing in it is already shipped", () => {
    expect(PENDING_PART_B.filter((f) => names.has(f))).toEqual([]);
  });

  it("every module has a title, checks, Out of static reach, and Severity guidance", () => {
    const missing: string[] = [];
    for (const [name, md] of Object.entries(modules)) {
      if (!/^# \S/.test(md)) missing.push(`${name}: title`);
      if (checks(md).length === 0) missing.push(`${name}: no \`- [ ]\` checks`);
      if (section(md, "Out of static reach") === null) missing.push(`${name}: ## Out of static reach`);
      if (section(md, "Severity guidance") === null) missing.push(`${name}: ## Severity guidance`);
    }
    expect(missing, `required sections missing:\n${missing.join("\n")}`).toEqual([]);
  });

  it("every gated module states its gate, and the gate table names every module", () => {
    const signals = gateSignals(BRAIN_AUDIT_FILES["SKILL.md"]);
    const problems: string[] = [];
    for (const [name, md] of Object.entries(modules)) {
      const signal = signals.get(name);
      if (signal === undefined) {
        problems.push(`${name}: no Decision Gates row`);
        continue;
      }
      const preamble = md.slice(0, md.indexOf("\n## ") === -1 ? md.length : md.indexOf("\n## "));
      const hasGate = /\bGate:/.test(preamble);
      const always = /^Always proposed/.test(signal);
      if (!always && !hasGate) problems.push(`${name}: gated by "${signal}" but no "Gate:" sentence in the preamble`);
      if (always && hasGate) problems.push(`${name}: always proposed in SKILL.md but states a Gate: sentence`);
    }
    expect(problems, `gate parity:\n${problems.join("\n")}`).toEqual([]);
  });
});
