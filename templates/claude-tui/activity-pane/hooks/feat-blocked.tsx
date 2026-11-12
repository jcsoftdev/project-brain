import type { Hook } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Api, Row, Span } from './register'
import { clean, fit, ICONS, shortName, span } from './register'

/** Who refused the call: the person, the auto-mode classifier, a settings rule or mode, or a hook. */
export type DenialCategory = 'user' | 'classifier' | 'rule' | 'hook'

export type Denial = {
  id: string
  at: number
  tool: string
  summary: string
  category: DenialCategory
  reason: string
  label?: string
  agentId?: string
  agent?: string
}

export type BlockedPart = { list: Denial[]; turnStartedAt: number }

/** What a structured signal said about a call before its `tool.call` resolved. */
export type DenialHint = { category: DenialCategory; reason: string }

type On = Parameters<Register>[0]

const KEEP = 100
const RECENT_MS = 10 * 60_000
const REASON_CHARS = 160
const SUMMARY_CHARS = 200
const HINTS_MAX = 50
const SECTION_KEY = 'blocked-section'
const SUMMARY_FIELDS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'skill', 'prompt'] as const

export const CATEGORY_ORDER: DenialCategory[] = ['user', 'classifier', 'rule', 'hook']

const CATEGORY_LABELS: Record<DenialCategory, string> = {
  user: 'Rechazadas por ti',
  classifier: 'Modo automático',
  rule: 'Reglas de permisos',
  hook: 'Hooks',
}

const blockedList = atom({ plugin: 'project-brain-activity', key: 'blockedList' } as const, [] as Denial[], { shape: 'blocked-list-1' })
const blockedTurn = atom({ plugin: 'project-brain-activity', key: 'blockedTurn' } as const, 0, { shape: 'blocked-turn-1' })

// Hints from tool.check and classic.PermissionDenied, keyed by tool_use_id, read when the call resolves.
// A reload drops them: that call then falls back to its result text.
const hints = new Map<string, DenialHint>()

const oneLine = (raw: string): string => clean(raw).replace(/\s+/g, ' ').trim()
const shorten = (raw: string, max: number): string => {
  const flat = oneLine(raw)
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** The classifier's `[Label]`, read only from the reason's first 400 characters. */
export const labelOf = (text: string): string | undefined => {
  const head = text.slice(0, 400)
  const found = /Reason:\s*\[([A-Za-z][A-Za-z0-9 &/-]{0,48})\]/.exec(head) ?? /\[([A-Z][A-Za-z0-9 &/-]{0,48})\]/.exec(head)
  return found?.[1] === undefined ? undefined : oneLine(found[1])
}

/**
 * The fallback when no structured hint arrived: bounded matches on the start of
 * the refusal text core hands the model. `isDeny` is a `{ deny }` result, a hook's
 * refusal unless the text says otherwise.
 */
export const categoryOfText = (text: string, isDeny: boolean): DenialCategory | undefined => {
  const head = text.slice(0, 300)
  if (/auto mode classifier/i.test(head)) return 'classifier'
  if (/^(Error: )?The user doesn't want to (proceed|take this action)/.test(head)) return 'user'
  if (/^(Error: )?PreToolUse:\S{1,80} hook error:/.test(head)) return 'hook'
  if (/^(Error: )?Permission (for this (action|command)|to use \S{1,80}).{0,80}(was|has been) denied/.test(head)) return 'rule'
  return isDeny ? 'hook' : undefined
}

/** A tool.check verdict as a hint: a deny names its hook or its rule; anything else is none. */
export const hintOfCheck = (verdict: { decision: string; reason?: string; rule?: string; hook?: string; setting?: string }): DenialHint | undefined => {
  if (verdict.decision !== 'deny') return undefined
  if (verdict.hook !== undefined) return { category: 'hook', reason: verdict.reason ?? verdict.hook }
  const named = verdict.rule ?? verdict.setting
  return { category: 'rule', reason: verdict.reason ?? (named === undefined ? '' : `regla ${named}`) }
}

/** The command, path or query the call carried, flattened and bounded. */
export const summaryOf = (input: Record<string, unknown>): string => {
  for (const field of SUMMARY_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.trim() !== '') return shorten(value, SUMMARY_CHARS)
  }
  return ''
}

/** The reason line kept for a denial: the hint's, else the refusal's first sentence. */
export const reasonOf = (category: DenialCategory, hintReason: string | undefined, text: string): string => {
  if (category === 'user') return 'rechazada por ti'
  const source = hintReason !== undefined && hintReason !== '' ? hintReason : text
  if (category === 'classifier') return shorten(source.replace(/^Error: /, '').replace(/ If you have other tasks[\s\S]*$/, ''), REASON_CHARS)
  return shorten(source.replace(/^Error: /, ''), REASON_CHARS)
}

export const addDenial = (list: Denial[], denial: Denial): Denial[] => [...list.filter(one => one.id !== denial.id), denial].slice(-KEEP)

/** Denials by category in CATEGORY_ORDER, newest first inside each; empty groups dropped. */
export const groupDenials = (list: Denial[]): { category: DenialCategory; items: Denial[] }[] =>
  CATEGORY_ORDER.map(category => ({ category, items: list.filter(one => one.category === category).sort((a, b) => b.at - a.at) })).filter(group => group.items.length > 0)

const remember = (id: string | undefined, hint: DenialHint | undefined): void => {
  if (id === undefined || hint === undefined) return
  hints.set(id, hint)
  while (hints.size > HINTS_MAX) {
    const oldest = hints.keys().next().value
    if (oldest === undefined) break
    hints.delete(oldest)
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export const registerBlocked = (on: On): void => {

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    try {
      remember(e.tool_use_id, hintOfCheck(verdict))
    } catch {
      // Observing only.
    }
    return verdict
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    const result = await next(e)
    try {
      remember(e.tool_use_id, { category: 'classifier', reason: text(e.reason) })
    } catch {
      // Observing only.
    }
    return result
  })

}

export async function readBlocked($: Api): Promise<BlockedPart> {
  return { list: await read($, blockedList), turnStartedAt: await read($, blockedTurn) }
}

export const rowsBlocked = (part: BlockedPart, ctx: { width: number; accent: string; isOpen: (key: string, byDefault: boolean) => boolean }): Row[] => {
  const { width } = ctx
  if (part.list.length === 0) return []
  const open = ctx.isOpen(SECTION_KEY, true)
  const title = `Bloqueos · ${part.list.length}`
  const rows: Row[] = [
    {
      key: SECTION_KEY,
      cells: [{ spans: [span(fit(`${open ? '▼' : '▶'} ${title}`, width))], action: { kind: 'toggle', key: SECTION_KEY }, label: title, key: `btn-${SECTION_KEY}` }],
    },
  ]
  if (!open) return rows
  for (const group of groupDenials(part.list)) {
    rows.push({ key: `blocked-group-${group.category}`, cells: [{ spans: [span(fit(`  ${CATEGORY_LABELS[group.category]} · ${group.items.length}`, width), { color: ctx.accent, bold: true })] }] })
    for (const one of group.items) {
      const head = `${one.tool}${one.summary === '' ? '' : `  ${one.summary}`}`
      rows.push({
        key: `blocked-row-${one.id}`,
        cells: [{ spans: [span('    '), span(`${ICONS.denied} `, { color: 'permission' }), span(fit(clean(head), width - 6))] }],
      })
      const why = [one.label === undefined ? '' : `[${one.label}]`, one.label !== undefined && one.category === 'classifier' ? '' : one.reason, one.agent === undefined ? '' : `agente ${one.agent}`]
        .filter(part => part !== '')
        .join(' · ')
      if (why !== '') rows.push({ key: `blocked-why-${one.id}`, cells: [{ spans: [span(fit(`      ${clean(why)}`, width), { dim: true })] }] })
    }
  }
  return rows
}

export const headerBlocked = (part: BlockedPart, now: number): Span[] => {
  const since = Math.min(now - RECENT_MS, part.turnStartedAt > 0 ? part.turnStartedAt : Number.POSITIVE_INFINITY)
  const recent = part.list.filter(one => one.at >= since).length
  return recent === 0 ? [] : [span(`${ICONS.denied} ${recent}`, { color: 'permission', bold: true })]
}

export async function blockedTurnStart($: Api, e: Parameters<Hook<'turn.start'>>[1], next: Parameters<Hook<'turn.start'>>[2]): Promise<Awaited<ReturnType<Hook<'turn.start'>>>> {
  try {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, blockedTurn, () => now)
    }
  } catch {
    // Observing only: a failed write leaves the header on its 10-minute window.
  }
  return next(e)
}

export async function blockedToolCall($: Api, e: Parameters<Hook<'tool.call'>>[1], next: Parameters<Hook<'tool.call'>>[2]): Promise<Awaited<ReturnType<Hook<'tool.call'>>>> {
  const ran = await next(e)
  try {
    const isDeny = ran.deny !== undefined
    if (!isDeny && ran.isError !== true) return ran
    const id = e.tool_use_id
    const hint = id === undefined ? undefined : hints.get(id)
    if (id !== undefined) hints.delete(id)
    const body = isDeny ? ran.deny : text(ran.text) || text(ran.result)
    const category = hint?.category ?? categoryOfText(body, isDeny)
    if (category === undefined) return ran
    const at = await $.clock.now()
    const label = category === 'classifier' ? labelOf(hint?.reason ?? '') ?? labelOf(body) : undefined
    const denial: Denial = {
      id: id ?? `blocked-${at}`,
      at,
      tool: shorten(e.tool, 60),
      summary: summaryOf(e as unknown as Record<string, unknown>),
      category,
      reason: reasonOf(category, hint?.reason, body),
      ...(label === undefined ? {} : { label }),
    }
    const loopId = e.agentId
    if (loopId !== undefined) {
      denial.agentId = loopId
      const info = (await $.agent.list().catch(() => [])).find(one => one.id === loopId)
      if (info) denial.agent = shorten(shortName({ description: info.description, ...(info.name ? { name: info.name } : {}) }), 40)
    }
    await update($, blockedList, list => addDenial(list, denial))
  } catch {
    // Observing only: the call's outcome stands whatever this bookkeeping does.
  }
  return ran
}
