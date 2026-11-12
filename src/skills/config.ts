import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { DATA_DIR } from "../constants.js";

/**
 * `~/.project-brain/skills.json`: one file for the per-prompt skill picker and the compact skill
 * listing, read by the suggest hook and by the project-brain-skill-listing mod alike. Every key is
 * optional; a missing or unreadable file means the defaults below.
 */
export interface SkillsConfig {
  /** The per-prompt Jev skill picks. `BRAIN_SKILL_PICKER=0` forces it off whatever this says. */
  picker: boolean;
  /** Safety ceiling on skills suggested for one prompt. `BRAIN_SKILL_PICK_MAX` overrides it. */
  pickCeiling: number;
  /** General-use skills: full line in the listing in every mode, never suggested by Jev. */
  general: string[];
  /** Without a picker, the most-used skills that keep their full line. */
  keepTop: number;
  /** Without a picker, a skill used within this many days keeps its full line too. */
  keepRecentDays: number;
}

export const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
  picker: true,
  pickCeiling: 10,
  general: [],
  keepTop: 15,
  keepRecentDays: 7,
};

type Env = Record<string, string | undefined>;

export const skillsConfigPath = (dataDir: string = DATA_DIR): string => join(dataDir, "skills.json");

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

export function parseSkillsConfig(text: string): Partial<SkillsConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: Partial<SkillsConfig> = {};
  if (typeof obj.picker === "boolean") out.picker = obj.picker;
  if (Array.isArray(obj.general)) out.general = obj.general.filter((n): n is string => typeof n === "string" && n !== "");
  const pickCeiling = positiveInt(obj.pickCeiling);
  if (pickCeiling) out.pickCeiling = pickCeiling;
  const keepTop = positiveInt(obj.keepTop);
  if (keepTop) out.keepTop = keepTop;
  const keepRecentDays = positiveInt(obj.keepRecentDays);
  if (keepRecentDays) out.keepRecentDays = keepRecentDays;
  return out;
}

/** The file's values over the defaults, then the env overrides. Synchronous so a hook can ask without ceremony. */
export function readSkillsConfig(dataDir: string = DATA_DIR, env: Env = process.env): SkillsConfig {
  let fromFile: Partial<SkillsConfig> = {};
  try {
    fromFile = parseSkillsConfig(readFileSync(skillsConfigPath(dataDir), "utf8"));
  } catch {
    // No file: the defaults stand.
  }
  const config = { ...DEFAULT_SKILLS_CONFIG, ...fromFile };
  if (env.BRAIN_SKILL_PICKER === "0") config.picker = false;
  const ceiling = Number.parseInt(env.BRAIN_SKILL_PICK_MAX ?? "", 10);
  if (Number.isInteger(ceiling) && ceiling > 0) config.pickCeiling = ceiling;
  return config;
}

/** Whether the file already records a general-use list, so setup asks for one only once. */
export async function hasGeneralList(dataDir: string): Promise<boolean> {
  const text = await readFile(skillsConfigPath(dataDir), "utf8").catch(() => "");
  return parseSkillsConfig(text).general !== undefined;
}

/** Replaces the general-use list and keeps every other key the user wrote, unknown ones included. */
export async function writeGeneralList(dataDir: string, general: string[]): Promise<void> {
  const path = skillsConfigPath(dataDir);
  let current: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) current = raw as Record<string, unknown>;
  } catch {
    // Absent or unreadable: start from an empty object.
  }
  await writeFileAtomic(path, `${JSON.stringify({ ...current, general: [...new Set(general)].sort() }, null, 2)}\n`);
}
