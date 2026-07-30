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
import {
  BRAIN_AUDIT_FILES,
  GENERATOR_MARKER,
  getSkillTargetDirs,
  inspectOwnership,
  installSkill,
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

  it("reports written targets", async () => {
    const { written, skipped } = await installSkill([dirA]);
    expect(written).toEqual([join(dirA, "brain-audit")]);
    expect(skipped).toEqual([]);
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
 * EMPTY as of Work Unit 2 — every one of the 34 gated modules now has real
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

  it("names all 34 modules, with no duplicates", () => {
    expect(gateRefs.length).toBe(34);
    expect(new Set(gateRefs).size).toBe(34);
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

    expect(written).toEqual([]);
    expect(skipped).toEqual([{ dir: skillDir, reason: "foreign" }]);
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(mine);
    expect(await readFile(join(skillDir, "references", "custom.md"), "utf8")).toBe("mine too");
  });

  it("a foreign target does not block a sibling target", async () => {
    await mkdir(join(dirA, "brain-audit"), { recursive: true });
    await writeFile(join(dirA, "brain-audit", "SKILL.md"), "hand-written");

    const { written, skipped } = await installSkill([dirA, dirB]);

    expect(written).toEqual([join(dirB, "brain-audit")]);
    expect(skipped.map((s) => s.dir)).toEqual([join(dirA, "brain-audit")]);
    expect(await readFile(join(dirB, "brain-audit", "SKILL.md"), "utf8")).toBe(
      BRAIN_AUDIT_FILES["SKILL.md"]
    );
  });
});
