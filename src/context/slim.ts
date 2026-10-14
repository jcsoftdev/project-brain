import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { parseMemoryFile, slugify, type MemorySection } from "./claude-md.js";

export const SKILL_PREFIX = "memory-";
const GENERATOR = "generator: project-brain-context-slim";

export interface SlimPaths {
  claudeDir: string;
}

export const defaultPaths = (): SlimPaths => ({ claudeDir: join(homedir(), ".claude") });

const claudeMdPath = (p: SlimPaths) => join(p.claudeDir, "CLAUDE.md");
const skillsDir = (p: SlimPaths) => join(p.claudeDir, "skills");
const backupsDir = (p: SlimPaths) => join(p.claudeDir, "context-slim");

export async function measure(paths: SlimPaths): Promise<MemorySection[]> {
  return parseMemoryFile(await readFile(claudeMdPath(paths), "utf8"));
}

export interface ApplyRequest {
  ids: string[];
  /** Used for every chosen section when given; otherwise derived from each heading. */
  description?: string;
  now?: Date;
}

export interface ApplyResult {
  moved: { id: string; skill: string; tokens: number }[];
  refused: { id: string; reason: string }[];
  backup: string | null;
}

interface Manifest {
  createdAt: string;
  skills: string[];
}

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, "-");

function pointerFor(section: MemorySection, skill: string): string {
  return `> "${section.title}" moved to the \`${skill}\` skill; load it when relevant.`;
}

function renderSkill(section: MemorySection, skill: string, description?: string): string {
  const desc =
    description ?? `Reference notes from the "${section.title}" section of CLAUDE.md. Load when the task touches: ${section.title}.`;
  return `---
name: ${skill}
description: ${JSON.stringify(desc)}
metadata:
  ${GENERATOR}
---

${section.text.trimEnd()}
`;
}

function refusalFor(section: MemorySection | undefined, id: string, paths: SlimPaths): string | null {
  if (!section) return "no such section (run without --apply to list ids)";
  if (section.kind === "project-brain") return "managed by project-brain; setup and update regenerate it";
  if (section.kind === "foreign") {
    const overrides = join(paths.claudeDir, "overrides");
    const hint = existsSync(overrides) ? ` Change it through ${overrides}.` : "";
    return `inside another tool's managed markers; that tool regenerates this content.${hint}`;
  }
  return null;
}

export async function applySlim(paths: SlimPaths, req: ApplyRequest): Promise<ApplyResult> {
  const original = await readFile(claudeMdPath(paths), "utf8");
  const sections = parseMemoryFile(original);
  const result: ApplyResult = { moved: [], refused: [], backup: null };

  const chosen: { section: MemorySection; skill: string }[] = [];
  for (const id of req.ids) {
    const section = sections.find((s) => s.id === id);
    const reason = refusalFor(section, id, paths);
    if (reason || !section) {
      result.refused.push({ id, reason: reason ?? "unknown" });
      continue;
    }
    const skill = `${SKILL_PREFIX}${slugify(section.title)}`;
    if (existsSync(join(skillsDir(paths), skill)) || chosen.some((c) => c.skill === skill)) {
      result.refused.push({ id, reason: `skill ${skill} already exists` });
      continue;
    }
    chosen.push({ section, skill });
  }
  if (chosen.length === 0) return result;

  const dir = join(backupsDir(paths), stamp(req.now ?? new Date()));
  await mkdir(dir, { recursive: true });
  await copyFile(claudeMdPath(paths), join(dir, "CLAUDE.md"));
  const manifest: Manifest = { createdAt: (req.now ?? new Date()).toISOString(), skills: [] };
  await writeFileAtomic(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  result.backup = dir;

  const lines = original.split("\n");
  for (const { section, skill } of chosen) {
    const skillDir = join(skillsDir(paths), skill);
    await writeFileAtomic(join(skillDir, "SKILL.md"), renderSkill(section, skill, req.description));
    manifest.skills.push(skillDir);
    await writeFileAtomic(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    result.moved.push({ id: section.id, skill, tokens: section.tokens });
  }

  // Bottom-up so earlier line indexes stay valid while splicing.
  for (const { section, skill } of [...chosen].sort((a, b) => b.section.start - a.section.start)) {
    lines.splice(section.start, section.end - section.start, pointerFor(section, skill), "");
  }
  await writeFileAtomic(claudeMdPath(paths), lines.join("\n"));
  return result;
}

export interface RevertResult {
  restored: string | null;
  removedSkills: string[];
  safetyCopy: string | null;
}

/** Safety copies outlive the backup dirs that a revert removes, so a second revert never trips over a leftover. */
const safetyDir = (p: SlimPaths) => join(backupsDir(p), "safety");

export async function revertSlim(paths: SlimPaths, now = new Date()): Promise<RevertResult> {
  const empty: RevertResult = { restored: null, removedSkills: [], safetyCopy: null };
  const root = backupsDir(paths);
  if (!existsSync(root)) return empty;
  const latest = (await readdir(root)).filter((name) => existsSync(join(root, name, "manifest.json"))).sort().pop();
  if (!latest) return empty;

  const dir = join(root, latest);
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;

  let safetyCopy: string | null = null;
  if (existsSync(claudeMdPath(paths))) {
    safetyCopy = join(safetyDir(paths), `CLAUDE.md.before-revert-${stamp(now)}`);
    await mkdir(safetyDir(paths), { recursive: true });
    await copyFile(claudeMdPath(paths), safetyCopy);
  }
  await writeFileAtomic(claudeMdPath(paths), await readFile(join(dir, "CLAUDE.md"), "utf8"));

  const removedSkills: string[] = [];
  for (const skillDir of manifest.skills) {
    const file = join(skillDir, "SKILL.md");
    if (!existsSync(file) || !(await readFile(file, "utf8")).includes(GENERATOR)) continue;
    await rm(skillDir, { recursive: true, force: true });
    removedSkills.push(skillDir);
  }

  await rm(dir, { recursive: true, force: true });
  return { restored: claudeMdPath(paths), removedSkills, safetyCopy };
}
