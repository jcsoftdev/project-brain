import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import type { SkillInfo } from "./discovery.js";

/**
 * Skills Claude Code lists that have no SKILL.md on disk (built-ins such as `dataviz`, connector
 * plugins such as `engineering:*`): the project-brain-skill-listing mod records each listed
 * description in `skill-listing.json`, so the picker can judge them as well. On the owner's machine
 * 43 of 137 listed skills were of this kind.
 */
export const LISTED_SKILLS_FILE = "skill-listing.json";

export async function readListedSkills(dataDir: string): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, LISTED_SKILLS_FILE), "utf8")) as { skills?: unknown };
    if (typeof raw.skills !== "object" || raw.skills === null || Array.isArray(raw.skills)) return {};
    return Object.fromEntries(Object.entries(raw.skills).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
  } catch {
    return {};
  }
}

/** The discovered skills, then every listed one discovery did not find. Its vector is keyed by its description, so a reworded one is embedded again. */
export function withListedSkills(discovered: SkillInfo[], listed: Record<string, string>): SkillInfo[] {
  const known = new Set(discovered.map((s) => s.name));
  const extra = Object.entries(listed)
    .filter(([name]) => !known.has(name))
    .map(([name, description]) => ({ name, description, path: `listing:${name}`, mtime: Number(BigInt(Bun.hash(description)) % 2_147_483_647n) }));
  return [...discovered, ...extra];
}

/** `skill-pick-health.json`: consecutive Jev failures, which the mod reads to stop stripping descriptions. */
export const PICK_HEALTH_FILE = "skill-pick-health.json";

export interface PickHealth {
  failures: number;
  lastSuccess?: number;
  lastFailure?: number;
}

export async function recordPickHealth(dataDir: string, ok: boolean, now: number = Date.now()): Promise<PickHealth> {
  const path = join(dataDir, PICK_HEALTH_FILE);
  let current: PickHealth = { failures: 0 };
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as PickHealth;
    if (typeof raw.failures === "number") current = raw;
  } catch {
    // First record.
  }
  const next: PickHealth = ok ? { failures: 0, lastSuccess: now, ...(current.lastFailure ? { lastFailure: current.lastFailure } : {}) } : { ...current, failures: current.failures + 1, lastFailure: now };
  await writeFileAtomic(path, `${JSON.stringify(next)}\n`);
  return next;
}
