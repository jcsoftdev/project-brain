import type { Hook } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Api, Row, Span, Tone } from './register'
import { clean, compact, fit, span } from './register'

/** One piece the context gate kept out of this session. */
export type GateDrop = { at: number; event: string; chars: number; score?: number; head: string }
export type GateSummary = { count: number; chars: number; last: GateDrop[] }

export type PromptPick = { at: number; skills: string[] }
export type DelegationPick = { agentId: string; description: string; skills: string[] }
export type SkillPicks = { prompts: PromptPick[]; delegations: DelegationPick[] }

export type ListingMode = 'jev' | 'stats' | 'passthrough'
export type LaneState = 'up' | 'mismatch' | 'dead' | 'pending' | 'off'
export type LaneView = { state: LaneState; reason?: string; at?: number }

/** What each project-brain filter did this session; an absent part draws as "—". */
export type SavingsState = {
  at: number
  gate?: GateSummary
  picks?: SkillPicks
  listing?: ListingMode
  lane?: LaneView
}

export type SavingsPart = SavingsState & { now: number }

/** A delegation the live transcript still holds, before its subagent's skills block is read. */
export type LiveDelegation = { agentId: string; description: string; prompt?: string }

/** One transcript entry still in the live conversation, oldest first. */
export type LiveEntry = Record<string, unknown>

const SECTION_KEY = 'savings-section'
const GATE_LAST = 3
const PROMPTS_SHOWN = 5
const DELEGATIONS_SHOWN = 5
/** Below the engine's 4 MiB stdout cap, so the tail always arrives whole. */
const TRANSCRIPT_TAIL_BYTES = 3 * 1024 * 1024
/** The skills block opens the subagent's first message, so its first line's head holds it. */
const SUBAGENT_HEAD_BYTES = 32 * 1024
const MAX_PICK_FAILURES = 3
const MIN_USAGE_INVOCATIONS = 10

export const LISTING_PLUGIN_KEY = 'project-brain-skill-listing@project-brain'
export const DELEGATION_SKILLS_HEADING = 'Skills for this task, picked for it (load one with the Skill tool when you reach the part it covers):'
const SKILL_LINE = /^Suggested skill: (\S+) — /
const LANE_OFF_VALUES = new Set(['off', 'none', 'false', '0', 'disabled'])

const EMPTY: SavingsState = { at: 0 }

const savingsAtom = atom({ plugin: 'project-brain-activity', key: 'savings' } as const, EMPTY, { shape: 'savings-1' })

// A reload resets these: it only costs one extra read of each source.
let refreshing: Promise<void> | undefined
let transcriptSeen: { path: string; mtimeMs: number; size: number } | undefined
const subagentSkills = new Map<string, string[]>()

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- context gate

/** This session's drops from `context-gate-log.json`: how many, their characters, and the newest few. */
export const gateSummaryOf = (text: string, sessionId: string, keep = GATE_LAST): GateSummary | undefined => {
  const raw = parseJson(text)
  if (!isObject(raw) || !Array.isArray(raw.dropped)) return undefined
  const mine: GateDrop[] = []
  for (const entry of raw.dropped) {
    if (!isObject(entry) || entry.session !== sessionId) continue
    const drop: GateDrop = {
      at: typeof entry.at === 'number' ? entry.at : 0,
      event: typeof entry.event === 'string' ? clean(entry.event).slice(0, 40) : '',
      chars: typeof entry.chars === 'number' && entry.chars > 0 ? entry.chars : 0,
      head: typeof entry.head === 'string' ? clean(entry.head).replace(/\s+/g, ' ').trim().slice(0, 160) : '',
    }
    if (typeof entry.score === 'number') drop.score = entry.score
    mine.push(drop)
  }
  const ordered = [...mine].sort((a, b) => a.at - b.at)
  return { count: mine.length, chars: mine.reduce((sum, one) => sum + one.chars, 0), last: ordered.slice(-keep).reverse() }
}

// ---------------------------------------------------------------- skill picks

/** Skill names on `Suggested skill: <name> — …` lines, in order, each once. */
export const skillNamesIn = (text: string): string[] => {
  const names: string[] = []
  for (const line of text.split('\n')) {
    const name = SKILL_LINE.exec(line.trim())?.[1]
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

/** The skills block a delegation's prompt opens with: the heading, then its consecutive skill lines. */
export const delegationSkillsIn = (text: string): string[] => {
  const at = text.indexOf(DELEGATION_SKILLS_HEADING)
  if (at < 0) return []
  const names: string[] = []
  for (const line of text.slice(at + DELEGATION_SKILLS_HEADING.length).split('\n').slice(1)) {
    const name = SKILL_LINE.exec(line.trim())?.[1]
    if (name === undefined) break
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/**
 * The entries still in the live conversation: the `parentUuid` chain walked back from the newest
 * entry, the same walk the suggest hook makes. A compaction boundary has no parent, so it stops there.
 */
export const liveEntriesOf = (tail: string): LiveEntry[] => {
  const byId = new Map<string, LiveEntry>()
  let leaf: string | undefined
  for (const line of tail.split('\n')) {
    if (!line.slice(0, 200).includes('"parentUuid"')) continue
    const entry = parseJson(line)
    if (!isObject(entry) || typeof entry.uuid !== 'string') continue
    byId.set(entry.uuid, entry)
    leaf = entry.uuid
  }
  const chain: LiveEntry[] = []
  const seen = new Set<string>()
  for (let id = leaf; id !== undefined && !seen.has(id); ) {
    const entry = byId.get(id)
    if (entry === undefined) break
    seen.add(id)
    chain.push(entry)
    id = typeof entry.parentUuid === 'string' ? entry.parentUuid : undefined
  }
  return chain.reverse()
}

/** A hook's printed output: plain lines, or the JSON document whose `additionalContext` carries them. */
const hookTextsOf = (attachment: Record<string, unknown>): string[] => {
  const values = [attachment.stdout, ...(Array.isArray(attachment.content) ? attachment.content : [attachment.content])]
  const texts: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    texts.push(value)
    if (!value.trimStart().startsWith('{')) continue
    const doc = parseJson(value)
    const context = isObject(doc) && isObject(doc.hookSpecificOutput) ? doc.hookSpecificOutput.additionalContext : undefined
    if (typeof context === 'string') texts.push(context)
  }
  return texts
}

const timeOf = (entry: LiveEntry): number => {
  const parsed = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/** The skills each prompt's suggest hook injected, one record per prompt that got any. */
export const promptPicksOf = (entries: LiveEntry[]): PromptPick[] => {
  const picks: PromptPick[] = []
  for (const entry of entries) {
    if (entry.type !== 'attachment' || !isObject(entry.attachment) || entry.attachment.hookEvent !== 'UserPromptSubmit') continue
    const skills = skillNamesIn(hookTextsOf(entry.attachment).join('\n'))
    if (skills.length > 0) picks.push({ at: timeOf(entry), skills })
  }
  return picks
}

/** Every delegation whose result the live conversation still holds, by its subagent's id. */
export const delegationsOf = (entries: LiveEntry[]): LiveDelegation[] => {
  const found = new Map<string, LiveDelegation>()
  for (const entry of entries) {
    const result = entry.toolUseResult
    if (!isObject(result) || typeof result.agentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(result.agentId)) continue
    const delegation: LiveDelegation = {
      agentId: result.agentId,
      description: typeof result.description === 'string' ? clean(result.description).slice(0, 80) : '',
    }
    if (typeof result.prompt === 'string') delegation.prompt = result.prompt
    found.set(result.agentId, delegation)
  }
  return [...found.values()]
}

/** The skills block in the head of a subagent transcript, whose first line may arrive cut short. */
export const subagentSkillsOf = (head: string): string[] => {
  const first = head.split('\n')[0] ?? ''
  const entry = parseJson(first)
  if (isObject(entry) && isObject(entry.message)) {
    const content = entry.message.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.map(part => (isObject(part) && typeof part.text === 'string' ? part.text : '')).join('\n') : ''
    return delegationSkillsIn(text)
  }
  return delegationSkillsIn(first.replace(/\\n/g, '\n').replace(/\\"/g, '"'))
}

// ---------------------------------------------------------------- skill listing

export type ListingInputs = {
  settings: string
  skills: string
  health: string
  reranker: string
  usage: string
  envToken?: string
  envPicker?: string
}

const pluginEnabled = (settings: unknown, key: string): boolean =>
  isObject(settings) && isObject(settings.enabledPlugins) && settings.enabledPlugins[key] === true

const suggestHookActive = (settings: unknown): boolean => {
  if (!isObject(settings) || settings.disableAllHooks === true || !isObject(settings.hooks)) return false
  const groups = settings.hooks.UserPromptSubmit
  return Array.isArray(groups) && groups.some(group =>
    isObject(group) && Array.isArray(group.hooks) && group.hooks.some(hook => isObject(hook) && typeof hook.command === 'string' && hook.command.includes('project-brain suggest')))
}

const tokenShaped = (envToken: string | undefined, fileText: string): boolean => {
  const shaped = (value: unknown) => typeof value === 'string' && /^\S{8,}$/.test(value)
  if (shaped(envToken)) return true
  const raw = parseJson(fileText)
  return isObject(raw) && shaped(raw.token)
}

const picksHealthy = (text: string): boolean => {
  const raw = parseJson(text)
  return !isObject(raw) || typeof raw.failures !== 'number' || raw.failures < MAX_PICK_FAILURES
}

const usageRanks = (text: string): boolean => {
  const raw = parseJson(text)
  if (!isObject(raw) || typeof raw.generatedAt !== 'number' || !isObject(raw.skills)) return false
  const total = Object.values(raw.skills).reduce<number>((sum, entry) => sum + (isObject(entry) && typeof entry.count === 'number' ? entry.count : 0), 0)
  return total >= MIN_USAGE_INVOCATIONS
}

/**
 * The main loop's listing mode, from the inputs the skill-listing mod reads: `jev` when the picker is
 * ready and the suggest hook installed; else `stats`, which passes the listing through until
 * `skill-usage.json` has enough history to rank by. Undefined when the mod is not enabled.
 */
export const listingModeOf = (inputs: ListingInputs): ListingMode | undefined => {
  const settings = parseJson(inputs.settings)
  if (!pluginEnabled(settings, LISTING_PLUGIN_KEY)) return undefined
  const config = parseJson(inputs.skills)
  const pickerOn = !(isObject(config) && config.picker === false) && inputs.envPicker !== '0'
  const ready = pickerOn && tokenShaped(inputs.envToken, inputs.reranker) && picksHealthy(inputs.health)
  if (ready && suggestHookActive(settings)) return 'jev'
  return usageRanks(inputs.usage) ? 'stats' : 'passthrough'
}

// ---------------------------------------------------------------- interactive lane

/** The configured interactive host, without trailing slashes; undefined when the lane is off. */
export const interactiveHostOf = (configText: string): string | undefined => {
  const raw = parseJson(configText)
  const value = isObject(raw) && typeof raw.interactiveHost === 'string' ? raw.interactiveHost.trim() : ''
  if (value === '' || LANE_OFF_VALUES.has(value.toLowerCase())) return undefined
  return value.replace(/\/+$/, '')
}

/** The verdict file prefix `lane.ts` writes for a host: `<slug(host)>__<slug(model)>.json`. */
export const laneFilePrefix = (host: string): string => `${host.replace(/[^a-z0-9]+/gi, '_')}__`

/** The newest verdict for the configured host; off without a host, undefined while none was written. */
export const laneOf = (configText: string, verdicts: { name: string; text: string }[]): LaneView | undefined => {
  const host = interactiveHostOf(configText)
  if (host === undefined) return { state: 'off' }
  const prefix = laneFilePrefix(host)
  let newest: LaneView | undefined
  for (const file of verdicts) {
    if (!file.name.startsWith(prefix) || !file.name.endsWith('.json')) continue
    const raw = parseJson(file.text)
    if (!isObject(raw) || typeof raw.at !== 'number') continue
    const state = raw.state === 'ok' ? 'up' : raw.state === 'mismatch' || raw.state === 'dead' || raw.state === 'pending' ? raw.state : undefined
    if (state === undefined || (newest?.at ?? -1) >= raw.at) continue
    newest = { state, at: raw.at }
    if (typeof raw.reason === 'string' && raw.reason.trim() !== '') newest.reason = clean(raw.reason).slice(0, 160)
  }
  return newest
}

// ---------------------------------------------------------------- rows

const agoLabel = (ms: number): string => {
  const secs = Math.max(0, Math.round(ms / 1000))
  if (secs < 60) return `hace ${secs} s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `hace ${mins} min`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `hace ${hours} h` : `hace ${Math.round(hours / 24)} d`
}

const LISTING_LABEL: Record<ListingMode, string> = {
  jev: 'jev · solo nombres, Jev trae cada skill',
  stats: 'stats · descripciones de las más usadas',
  passthrough: 'passthrough · sin historial, listado completo',
}

const LANE_LOOK: Record<LaneState, { text: string; color: Tone }> = {
  up: { text: '✓ activa', color: 'success' },
  mismatch: { text: '✗ no coincide', color: 'error' },
  dead: { text: '✗ caída', color: 'error' },
  pending: { text: '… verificando', color: 'warning' },
  off: { text: 'apagada', color: 'subtle' },
}

const pickedCount = (picks: SkillPicks): number => picks.prompts.reduce((sum, one) => sum + one.skills.length, 0) + picks.delegations.reduce((sum, one) => sum + one.skills.length, 0)

const laneBroken = (lane: LaneView | undefined): boolean => lane?.state === 'mismatch' || lane?.state === 'dead'

export const headerLabelSavings = (part: SavingsState): string => {
  const parts = ['Filtros']
  if (part.gate && part.gate.count > 0) parts.push(`⊘ ${part.gate.count} · ≈${compact(Math.round(part.gate.chars / 4))} tok`)
  if (part.picks) parts.push(`${pickedCount(part.picks)} skills`)
  if (part.lane) parts.push(`lane ${part.lane.state === 'up' ? '✓' : laneBroken(part.lane) ? '✗' : part.lane.state === 'off' ? 'off' : '…'}`)
  return parts.join(' · ')
}

export const rowsSavings = (
  part: SavingsPart,
  ctx: { width: number; accent: string; isOpen: (key: string, byDefault: boolean) => boolean },
): Row[] => {
  const width = Math.max(20, ctx.width)
  const label = headerLabelSavings(part)
  const open = ctx.isOpen(SECTION_KEY, false)
  const header: Row = {
    key: SECTION_KEY,
    cells: [{ spans: [span(fit(`${open ? '▼' : '▶'} ${label}`, width))], action: { kind: 'toggle', key: SECTION_KEY }, label, key: `btn-${SECTION_KEY}` }],
  }
  if (!open) return [header]

  const line = (key: string, value: string, style: Omit<Span, 'text'> = {}): Row => ({ key, cells: [{ spans: [span(fit(value, width), style)] }] })
  const labeled = (key: string, name: string, value: string, style: Omit<Span, 'text'> = {}): Row => {
    const head = `  ${name}: `
    return { key, cells: [{ spans: [span(fit(head, width), { dim: true }), ...(head.length < width ? [span(fit(value, width - head.length), style)] : [])] }] }
  }
  const body: Row[] = []

  const { gate } = part
  if (gate === undefined) body.push(labeled('savings-gate', 'Context gate', '—', { dim: true }))
  else if (gate.count === 0) body.push(labeled('savings-gate', 'Context gate', 'sin descartes en esta sesión', { dim: true }))
  else {
    const pieces = gate.count === 1 ? '1 pieza descartada' : `${gate.count} piezas descartadas`
    body.push(labeled('savings-gate', 'Context gate', `${pieces} · ${compact(gate.chars)} car. (≈${compact(Math.round(gate.chars / 4))} tokens)`))
    gate.last.forEach((drop, index) => {
      const score = drop.score === undefined ? ' — ' : drop.score.toFixed(2)
      body.push(line(`savings-drop-${index}`, `    ${score} ${drop.event} · ${drop.head}`, { dim: true }))
    })
  }

  const { picks } = part
  if (picks === undefined) body.push(labeled('savings-prompts', 'Skills por prompt', '—', { dim: true }))
  else {
    body.push(labeled('savings-prompts', 'Skills por prompt', picks.prompts.length === 0 ? 'ninguna en el contexto vivo' : `${picks.prompts.length} prompts`, picks.prompts.length === 0 ? { dim: true } : {}))
    picks.prompts.slice(-PROMPTS_SHOWN).reverse().forEach((one, index) => {
      const when = one.at > 0 && part.now > 0 ? `${agoLabel(part.now - one.at)} · ` : ''
      body.push(line(`savings-prompt-${index}`, `    ${when}${one.skills.join(', ')}`))
    })
    body.push(labeled('savings-delegations', 'Skills por delegación', picks.delegations.length === 0 ? 'ninguna en el contexto vivo' : `${picks.delegations.length} delegaciones`, picks.delegations.length === 0 ? { dim: true } : {}))
    picks.delegations.slice(-DELEGATIONS_SHOWN).reverse().forEach((one, index) => {
      const skills = one.skills.length === 0 ? 'sin skills' : one.skills.join(', ')
      body.push(line(`savings-delegation-${index}`, `    ${one.description || one.agentId} → ${skills}`, one.skills.length === 0 ? { dim: true } : {}))
    })
  }

  body.push(part.listing === undefined
    ? labeled('savings-listing', 'Listado de skills', '—', { dim: true })
    : labeled('savings-listing', 'Listado de skills', LISTING_LABEL[part.listing], part.listing === 'passthrough' ? { dim: true } : {}))

  const { lane } = part
  if (lane === undefined) body.push(labeled('savings-lane', 'Lane Ollama interactiva', '—', { dim: true }))
  else {
    const look = LANE_LOOK[lane.state]
    const when = lane.at !== undefined && part.now > 0 ? ` · ${agoLabel(part.now - lane.at)}` : ''
    body.push(labeled('savings-lane', 'Lane Ollama interactiva', `${look.text}${when}`, { color: look.color }))
    if (lane.state === 'mismatch' && lane.reason) body.push(line('savings-lane-reason', `    ${lane.reason}`, { dim: true }))
  }
  return [header, ...body]
}

/** Footer tokens only when a filter did something worth seeing, or the lane broke. */
export const footerSavings = (part: SavingsState): Span[] => {
  const spans: Span[] = []
  if (part.gate && part.gate.count > 0) spans.push(span(`⊘ ${part.gate.count} filtrados`, { color: 'suggestion' }))
  if (laneBroken(part.lane)) spans.push(span('lane ✗', { color: 'error' }))
  return spans
}

// ---------------------------------------------------------------- reads

export async function readSavings($: Api): Promise<SavingsPart> {
  const [state, now] = await Promise.all([read($, savingsAtom).catch(() => EMPTY), $.clock.now().catch(() => 0)])
  return { ...state, now }
}

async function readText($: Api, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

/** A file's tail through `tail -c`, or the whole file when it is smaller than that. */
async function tailOf($: Api, path: string, bytes: number, size: number): Promise<string> {
  if (size <= bytes) return readText($, path)
  const out = await $.process.run(['/usr/bin/tail', '-c', String(bytes), path], { timeoutMs: 3000 })
  return out.exitCode === 0 ? out.stdout : ''
}

async function readGate($: Api, home: string, sessionId: string): Promise<GateSummary | undefined> {
  const text = await readText($, `${home}/.project-brain/context-gate-log.json`)
  return text === '' ? undefined : gateSummaryOf(text, sessionId)
}

async function skillsOfSubagent($: Api, dir: string, delegation: LiveDelegation): Promise<string[]> {
  const inline = delegation.prompt === undefined ? [] : delegationSkillsIn(delegation.prompt)
  if (inline.length > 0) return inline
  const known = subagentSkills.get(delegation.agentId)
  if (known !== undefined) return known
  const out = await $.process.run(['/usr/bin/head', '-c', String(SUBAGENT_HEAD_BYTES), `${dir}/agent-${delegation.agentId}.jsonl`], { timeoutMs: 2000 }).catch(() => undefined)
  if (out === undefined || out.exitCode !== 0) return []
  const skills = subagentSkillsOf(out.stdout)
  subagentSkills.set(delegation.agentId, skills)
  return skills
}

/** Re-reads the transcript tail only when the file changed; undefined keeps the stored picks. */
async function readPicks($: Api, claudeDir: string, sessionId: string): Promise<SkillPicks | undefined | null> {
  const root = await $.session.root()
  const base = `${claudeDir}/projects/${root.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}`
  const path = `${base}.jsonl`
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file') return null
  const size = stat.size ?? 0
  const mtimeMs = stat.mtimeMs ?? 0
  if (transcriptSeen?.path === path && transcriptSeen.size === size && transcriptSeen.mtimeMs === mtimeMs) return undefined
  const tail = await tailOf($, path, TRANSCRIPT_TAIL_BYTES, size)
  const entries = liveEntriesOf(tail)
  const delegations: DelegationPick[] = []
  for (const one of delegationsOf(entries)) {
    const skills = await skillsOfSubagent($, `${base}/subagents`, one).catch(() => [])
    delegations.push({ agentId: one.agentId, description: one.description, skills })
  }
  transcriptSeen = { path, size, mtimeMs }
  return { prompts: promptPicksOf(entries), delegations }
}

async function readListing($: Api, home: string, claudeDir: string): Promise<ListingMode | undefined> {
  const [settings, skills, health, reranker, usage, envToken, envPicker] = await Promise.all([
    readText($, `${claudeDir}/settings.json`),
    readText($, `${home}/.project-brain/skills.json`),
    readText($, `${home}/.project-brain/skill-pick-health.json`),
    readText($, `${home}/.project-brain/reranker.json`),
    readText($, `${home}/.project-brain/skill-usage.json`),
    $.env.get('TYPESAFE_API_KEY').catch(() => undefined),
    $.env.get('BRAIN_SKILL_PICKER').catch(() => undefined),
  ])
  const inputs: ListingInputs = { settings, skills, health, reranker, usage }
  if (envToken !== undefined) inputs.envToken = envToken
  if (envPicker !== undefined) inputs.envPicker = envPicker
  return listingModeOf(inputs)
}

async function readLane($: Api, home: string): Promise<LaneView | undefined> {
  const config = await readText($, `${home}/.project-brain/ollama.json`)
  const host = interactiveHostOf(config)
  if (host === undefined) return { state: 'off' }
  const dir = `${home}/.project-brain/lane`
  const prefix = laneFilePrefix(host)
  const listed = await $.fs.list(dir).catch(() => [])
  const files = listed.filter(entry => entry.kind === 'file' && entry.name.startsWith(prefix) && entry.name.endsWith('.json')).slice(0, 20)
  const verdicts = await Promise.all(files.map(async entry => ({ name: entry.name, text: await readText($, `${dir}/${entry.name}`) })))
  return laneOf(config, verdicts)
}

async function refreshSavings($: Api): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const [home, sessionId, configDir, at] = await Promise.all([
      $.env.get('HOME').catch(() => undefined),
      $.session.id().catch(() => ''),
      $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined),
      $.clock.now(),
    ])
    if (!home) return
    const claudeDir = configDir || `${home}/.claude`
    const [gate, picks, listing, lane] = await Promise.all([
      sessionId ? readGate($, home, sessionId).catch(() => undefined) : Promise.resolve(undefined),
      sessionId ? readPicks($, claudeDir, sessionId).catch(() => null) : Promise.resolve(null),
      readListing($, home, claudeDir).catch(() => undefined),
      readLane($, home).catch(() => undefined),
    ])
    await update($, savingsAtom, previous => {
      const next: SavingsState = { at }
      if (gate !== undefined) next.gate = gate
      const keptPicks = picks === undefined ? previous.picks : picks ?? undefined
      if (keptPicks !== undefined) next.picks = keptPicks
      if (listing !== undefined) next.listing = listing
      if (lane !== undefined) next.lane = lane
      return next
    })
  })()
    .catch(() => undefined)
    .finally(() => {
      refreshing = undefined
    })
  return refreshing
}

export async function savingsSessionStart($: Api, e: Parameters<Hook<'session.start'>>[1], next: Parameters<Hook<'session.start'>>[2]): Promise<Awaited<ReturnType<Hook<'session.start'>>>> {
  const result = await next(e)
  transcriptSeen = undefined
  void refreshSavings($).catch(() => undefined)
  return result
}

export async function savingsTurnComplete($: Api, e: Parameters<Hook<'turn.complete'>>[1], next: Parameters<Hook<'turn.complete'>>[2]): Promise<Awaited<ReturnType<Hook<'turn.complete'>>>> {
  const result = await next(e)
  if (e.agentId === undefined) void refreshSavings($).catch(() => undefined)
  return result
}
