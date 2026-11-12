import type { Hook, Register } from 'claude-code'

import type { Listing, ListingEntry, ListingMode, SkillsConfig, SkillUsage } from '../types'

type Api = Parameters<Hook<'prompt.attachment'>>[0]

const DAY_MS = 24 * 60 * 60_000
const USAGE_REFRESH_TIMEOUT_MS = 120_000
/** Past the CLI's own 5 s self-timeout, so it is the CLI that gives up and the delegation goes out unchanged. */
const DELEGATION_TIMEOUT_MS = 6_000

export const DEFAULT_CONFIG: SkillsConfig = { picker: true, general: [], keepTop: 15, keepRecentDays: 7 }

export const OTHER_SKILLS_PREFIX = '- Other skills (name only; invoke by name when one fits the request): '

/**
 * `- name: description`, `- name (alias): description` or `- name`. Names carry no spaces, so the
 * first `: ` ends the name even in `plugin:skill`.
 */
const ENTRY = /^- (\S+?)(?:: | \(\S+\)(?:: |$)|$)/

/** The listing's skills in order, each with its continuation lines; null when the text holds none. */
export function parseListing(text: string): Listing | null {
  const preamble: string[] = []
  const entries: ListingEntry[] = []
  for (const line of text.split('\n')) {
    const name = ENTRY.exec(line)?.[1]
    if (name !== undefined) entries.push({ name, lines: [line] })
    else if (entries.length === 0) preamble.push(line)
    else entries[entries.length - 1]!.lines.push(line)
  }
  return entries.length === 0 ? null : { preamble, entries }
}

/**
 * Full lines for the skills in `keep`, in their original order, then every other name on one
 * trailing line. Every name survives; the text comes back unchanged when nothing would be cut.
 */
export function compactListing(text: string, keep: ReadonlySet<string>): string {
  const listing = parseListing(text)
  if (listing === null) return text
  const kept = listing.entries.filter(entry => keep.has(entry.name))
  const named = listing.entries.filter(entry => !keep.has(entry.name)).map(entry => entry.name)
  if (named.length === 0) return text
  const trailing = (lines: string[]) => {
    let end = lines.length
    while (end > 0 && lines[end - 1]!.trim() === '') end--
    return lines.slice(0, end)
  }
  return [
    ...listing.preamble,
    ...kept.flatMap(entry => trailing(entry.lines)),
    `${OTHER_SKILLS_PREFIX}${named.join(', ')}`,
  ].join('\n')
}

/**
 * The skills that keep their full line. With the Jev picker, only the general-use ones: the picker
 * brings each prompt's skills in full. Without it, also the `brain-*` core, the most used and the
 * recently used, counted only among `listed` so a slash command like `/clear` never takes a slot.
 */
export function keepSet(listed: string[], mode: ListingMode, config: SkillsConfig, usage: SkillUsage | null, now: number): Set<string> {
  const names = new Set(listed)
  const general = config.general.filter(name => names.has(name))
  if (mode === 'jev' || usage === null) return new Set(general)
  const used = Object.entries(usage.skills).filter(([name]) => names.has(name))
  const top = [...used].sort((a, b) => b[1].count - a[1].count || b[1].lastUsed - a[1].lastUsed).slice(0, config.keepTop)
  const recentSince = now - config.keepRecentDays * DAY_MS
  return new Set([
    ...general,
    ...listed.filter(name => name.startsWith('brain-')),
    ...top.map(([name]) => name),
    ...used.filter(([, entry]) => entry.lastUsed >= recentSince).map(([name]) => name),
  ])
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const positiveInt = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback

export function parseConfig(text: string): SkillsConfig {
  try {
    const raw: unknown = JSON.parse(text)
    if (!isObject(raw)) return DEFAULT_CONFIG
    return {
      picker: typeof raw.picker === 'boolean' ? raw.picker : DEFAULT_CONFIG.picker,
      general: Array.isArray(raw.general) ? raw.general.filter((name): name is string => typeof name === 'string') : [],
      keepTop: positiveInt(raw.keepTop, DEFAULT_CONFIG.keepTop),
      keepRecentDays: positiveInt(raw.keepRecentDays, DEFAULT_CONFIG.keepRecentDays),
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

/** Fewer recorded invocations than this rank nothing: the listing passes through until there is history. */
export const MIN_USAGE_INVOCATIONS = 10

export function parseUsage(text: string): SkillUsage | null {
  try {
    const raw: unknown = JSON.parse(text)
    if (!isObject(raw) || typeof raw.generatedAt !== 'number' || !isObject(raw.skills)) return null
    const usage = raw as SkillUsage
    const total = Object.values(usage.skills).reduce((sum, entry) => sum + (typeof entry?.count === 'number' ? entry.count : 0), 0)
    return total >= MIN_USAGE_INVOCATIONS ? usage : null
  } catch {
    return null
  }
}

/** After this many Jev failures in a row the listing keeps descriptions until a pick succeeds again. */
export const MAX_PICK_FAILURES = 3

/** `~/.project-brain/skill-pick-health.json`, written by the suggest CLI after every Jev request it makes. */
export function picksHealthy(text: string): boolean {
  try {
    const raw: unknown = JSON.parse(text)
    return !isObject(raw) || typeof raw.failures !== 'number' || raw.failures < MAX_PICK_FAILURES
  } catch {
    return true
  }
}

/** A token worth trying: one non-empty string with no whitespace, read from the env or from `{ "token": … }`. */
export function tokenShaped(envToken: string | undefined, fileText: string): boolean {
  const shaped = (value: unknown) => typeof value === 'string' && /^\S{8,}$/.test(value)
  if (shaped(envToken)) return true
  try {
    const raw: unknown = JSON.parse(fileText)
    return isObject(raw) && shaped(raw.token)
  } catch {
    return false
  }
}

/** Whether Claude Code would run the suggest hook: installed under UserPromptSubmit, and hooks not disabled. */
export function suggestHookActive(settingsText: string): boolean {
  try {
    const raw: unknown = JSON.parse(settingsText)
    if (!isObject(raw) || raw.disableAllHooks === true || !isObject(raw.hooks)) return false
    const groups = raw.hooks.UserPromptSubmit
    if (!Array.isArray(groups)) return false
    return groups.some(group =>
      isObject(group) && Array.isArray(group.hooks) && group.hooks.some(hook => isObject(hook) && typeof hook.command === 'string' && hook.command.includes('project-brain suggest')))
  } catch {
    return false
  }
}

/**
 * The listing for one attachment. `stats` without usage numbers passes the text through: cutting
 * descriptions with nothing to rank them by would hide the skills the owner relies on.
 */
export function rewriteListing(text: string, mode: ListingMode, config: SkillsConfig, usage: SkillUsage | null, now: number): string {
  if (mode === 'stats' && usage === null) return text
  const listing = parseListing(text)
  if (listing === null) return text
  return compactListing(text, keepSet(listing.entries.map(entry => entry.name), mode, config, usage, now))
}

const ENTRY_HEAD = /^- \S+?(?: \(\S+\))?(?:: |$)/

/**
 * Each listed skill's description, as Claude Code worded it. The picker reads them from
 * `skill-listing.json` so built-in and connector skills, which have no SKILL.md on disk, can be picked too.
 */
export function listedDescriptions(text: string): Record<string, string> {
  const listing = parseListing(text)
  if (listing === null) return {}
  return Object.fromEntries(
    listing.entries.map(entry => {
      const [head = '', ...rest] = entry.lines
      return [entry.name, [head.replace(ENTRY_HEAD, ''), ...rest].join('\n').trim()]
    })
  )
}

async function readOr($: Api, path: string, fallback: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return fallback
  }
}

/** Jev can pick skills: on in config and env, a token of the right shape, and no run of recent failures. */
async function pickerReady($: Api, config: SkillsConfig, home: string): Promise<boolean> {
  if (!config.picker || (await $.env.get('BRAIN_SKILL_PICKER')) === '0') return false
  const fileToken = await readOr($, `${home}/.project-brain/reranker.json`, '')
  if (!tokenShaped(await $.env.get('TYPESAFE_API_KEY'), fileToken)) return false
  return picksHealthy(await readOr($, `${home}/.project-brain/skill-pick-health.json`, ''))
}

/** Subagents whose spawn carried a skills block, and the spawns still resolving their ids. */
const pickedAgents = new Set<string>()
const pendingSpawns = new Set<Promise<unknown>>()
/** How long a subagent's listing waits for its own spawn to report its id before falling back to `stats`. */
const SPAWN_WAIT_MS = 1_500

async function spawnCarriedSkills($: Api, agentId: string): Promise<boolean> {
  if (pickedAgents.has(agentId)) return true
  if (pendingSpawns.size === 0) return false
  await Promise.race([Promise.allSettled([...pendingSpawns]), $.clock.sleep(SPAWN_WAIT_MS)])
  return pickedAgents.has(agentId)
}

/**
 * `jev` when something brings this loop's skills back in full: on the main loop the suggest hook,
 * per prompt; in a subagent the skills block its spawn carried. Anything else keeps descriptions.
 */
async function modeOf($: Api, config: SkillsConfig, home: string, agentId: string | undefined): Promise<ListingMode> {
  if (!(await pickerReady($, config, home))) return 'stats'
  if (agentId !== undefined) return (await spawnCarriedSkills($, agentId)) ? 'jev' : 'stats'
  const claudeDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  return suggestHookActive(await readOr($, `${claudeDir}/settings.json`, '')) ? 'jev' : 'stats'
}

async function rememberDescriptions($: Api, home: string, text: string, now: number): Promise<void> {
  const path = `${home}/.project-brain/skill-listing.json`
  let known: Record<string, string> = {}
  try {
    const raw: unknown = JSON.parse(await readOr($, path, '{}'))
    if (isObject(raw) && isObject(raw.skills)) known = raw.skills as Record<string, string>
  } catch {
    // Unreadable: rebuilt from this listing.
  }
  const merged = { ...known, ...listedDescriptions(text) }
  if (JSON.stringify(merged) === JSON.stringify(known)) return
  await $.fs.write(path, `${JSON.stringify({ updatedAt: now, skills: merged }, null, 2)}\n`)
}

async function compactAttachment($: Api, text: string, agentId: string | undefined): Promise<string> {
  const home = await $.env.get('HOME')
  if (!home) return text
  const now = await $.clock.now()
  await rememberDescriptions($, home, text, now).catch(() => undefined)
  const config = parseConfig(await readOr($, `${home}/.project-brain/skills.json`, ''))
  const usage = parseUsage(await readOr($, `${home}/.project-brain/skill-usage.json`, ''))
  return rewriteListing(text, await modeOf($, config, home, agentId), config, usage, now)
}

/**
 * The skills block goes first, so a delegation that ends with its own output contract still ends
 * with it; the prompt comes back unchanged when nothing was picked or anything failed.
 */
export const withDelegationSkills = (prompt: string, block: string): string =>
  block.trim() === '' ? prompt : `${block.trim()}\n\n${prompt}`

/** The CLI owns the pick (one Jev request, the same floor and ceiling as the prompt hook); the mod only carries its answer. */
async function delegationSkills($: Api, prompt: string, description: string): Promise<string> {
  const home = await $.env.get('HOME')
  if (!home) return ''
  const config = parseConfig(await readOr($, `${home}/.project-brain/skills.json`, ''))
  if (!(await pickerReady($, config, home))) return ''
  const { exitCode, stdout } = await $.process.run(['project-brain', 'suggest', '--agent', '--stdin'], {
    stdin: JSON.stringify({ prompt, description }),
    timeoutMs: DELEGATION_TIMEOUT_MS,
  })
  return exitCode === 0 ? stdout : ''
}

/** Daily at most: the CLI skips a file under a day old, and a second session waits on the first one's lock. */
async function refreshUsage($: Api): Promise<void> {
  await $.process.run(['project-brain', 'skill-usage', '--write', '--if-stale'], { timeoutMs: USAGE_REFRESH_TIMEOUT_MS })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void refreshUsage($ as unknown as Api).catch(() => undefined)
    return next(e)
  })

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    if (e.origin.kind !== 'engine') return next(e)
    try {
      return next({ ...e, text: await compactAttachment($, e.text, e.agentId) })
    } catch {
      return next(e)
    }
  })

  on('agent.spawn', async ($, e, next) => {
    let block = ''
    try {
      block = (await delegationSkills($ as unknown as Api, e.prompt, e.description)).trim()
    } catch {
      block = ''
    }
    const spawning = next(block === '' ? e : { ...e, prompt: withDelegationSkills(e.prompt, block) })
    if (block === '') return spawning
    const tracked = spawning.then(spawned => {
      if (spawned.agentId !== undefined) pickedAgents.add(spawned.agentId)
    })
    pendingSpawns.add(tracked)
    void tracked.catch(() => undefined).finally(() => pendingSpawns.delete(tracked))
    return spawning
  }).catch(($, e, next) => next(e))
}
