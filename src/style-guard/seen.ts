import type { ShippedSkill } from "./rules.js";

export function seenKey(agentId: string, skill: ShippedSkill): string {
  return `${agentId}:${skill}`;
}

export function unseenSkills(seen: ReadonlySet<string>, agentId: string, skills: readonly ShippedSkill[]): ShippedSkill[] {
  return skills.filter((skill) => !seen.has(seenKey(agentId, skill)));
}

export function markSeen(seen: ReadonlySet<string>, agentId: string, skills: readonly ShippedSkill[]): string[] {
  return [...new Set([...seen, ...skills.map((skill) => seenKey(agentId, skill))])];
}

export function parseSeen(raw: string | null): Set<string> {
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}
