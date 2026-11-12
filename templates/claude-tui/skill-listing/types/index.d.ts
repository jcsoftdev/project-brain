/** `~/.project-brain/skill-usage.json`, written by `project-brain skill-usage --write`. */
export type SkillUsage = {
  generatedAt: number
  windowDays: number
  skills: Record<string, { count: number; lastUsed: number }>
}

/** `~/.project-brain/skills.json`, shared with the suggest hook's skill picker. */
export type SkillsConfig = {
  picker: boolean
  general: string[]
  keepTop: number
  keepRecentDays: number
}

/** One skill of the listing: its first line and any continuation lines of its description. */
export type ListingEntry = { name: string; lines: string[] }

export type Listing = { preamble: string[]; entries: ListingEntry[] }

/** `jev`: the per-prompt picker supplies descriptions. `stats`: the most-used skills keep theirs. */
export type ListingMode = 'jev' | 'stats'
