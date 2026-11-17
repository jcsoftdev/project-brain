import type { Hook } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { ContextCategory, Register, SessionCompactResult, SessionContextBreakdown, SessionContextUsage } from 'claude-code'

import type { Api, Row, Span, Tone } from './register'
import { againstCompaction, clean, compact, contextPercentOf, fit, span } from './register'

/** One breakdown row the pane keeps: deferred schemas sit outside the window and are dropped. */
export type ContextRowKind = 'used' | 'free' | 'buffer'
export type ContextRowRecord = { name: string; tokens: number; kind: ContextRowKind }

/** The last breakdown read, against the window its categories sum to (the compaction window). */
export type ContextBreakdownState = {
  rows: ContextRowRecord[]
  window: number
  total: number
  autoCompactAt?: number
  at: number
}

/** Compactions of the main conversation this session. */
export type CompactionRecord = { count: number; lastAt: number; before?: number; after?: number }

export type ContextPart = {
  breakdown: ContextBreakdownState
  compactions: CompactionRecord
  /** The session's live figures, measured against the model's window. */
  usage: { tokens?: number; window: number; percent?: number }
  now: number
}

type On = Parameters<Register>[0]

const REFRESH_MS = 15_000
const MAX_ROWS = 20
const WARN_PERCENT = 80
const ERROR_PERCENT = 90
const BAR_CELLS = 8
const SECTION_KEY = 'ctxb-section'

const EMPTY_BREAKDOWN: ContextBreakdownState = { rows: [], window: 0, total: 0, at: 0 }
const EMPTY_COMPACTIONS: CompactionRecord = { count: 0, lastAt: 0 }
const EMPTY_LIVE: ContextPart['usage'] = { window: 0 }

const breakdownAtom = atom({ plugin: 'project-brain-activity', key: 'contextBreakdown' } as const, EMPTY_BREAKDOWN, { shape: 'context-breakdown-1' })
const compactionsAtom = atom({ plugin: 'project-brain-activity', key: 'contextCompactions' } as const, EMPTY_COMPACTIONS, { shape: 'context-compactions-1' })
const liveAtom = atom({ plugin: 'project-brain-activity', key: 'contextLive' } as const, EMPTY_LIVE, { shape: 'context-live-1' })

const LABELS: Record<string, string> = {
  'System prompt': 'Sistema',
  'System tools': 'Herramientas',
  'MCP tools': 'MCP',
  Messages: 'Mensajes',
  'Memory files': 'Memoria (CLAUDE.md)',
  Skills: 'Skills',
  'Free space': 'Libre',
  'Autocompact buffer': 'Reserva de compactación',
}

// A reload resets these: it only costs one extra breakdown read.
let lastRefreshAt = 0
let refreshing: Promise<void> | undefined

/** The Spanish label for an engine category name; unknown names pass through, cleaned. */
export const contextLabelOf = (name: string): string => LABELS[name] ?? clean(name).slice(0, 60)

const isKept = (row: ContextCategory): row is ContextCategory & { kind: ContextRowKind } =>
  !row.isDeferred && (row.kind === 'used' || row.kind === 'free' || row.kind === 'buffer')

/** The engine's breakdown as the pane stores it: bounded, deferred rows dropped, numbers only. */
export const breakdownOf = (raw: SessionContextBreakdown, at: number): ContextBreakdownState => {
  const rows = raw.categories
    .filter(isKept)
    .slice(0, MAX_ROWS)
    .map(row => ({ name: clean(String(row.name)).slice(0, 60), tokens: Math.max(0, Number(row.tokens) || 0), kind: row.kind }))
  const state: ContextBreakdownState = { rows, window: Math.max(0, raw.rawMaxTokens || 0), total: Math.max(0, raw.totalTokens || 0), at }
  if (raw.isAutoCompactEnabled && typeof raw.autoCompactThreshold === 'number') state.autoCompactAt = raw.autoCompactThreshold
  return state
}

/** Folds one `session.compact` result into the record; skips and precomputes change nothing. */
export const recordCompaction = (
  record: CompactionRecord,
  result: SessionCompactResult | undefined,
  trigger: string,
  at: number,
): CompactionRecord => {
  if (result === undefined || result.skip !== undefined || trigger === 'precompute') return record
  const next: CompactionRecord = { count: record.count + 1, lastAt: at }
  if (typeof result.tokensBefore === 'number') next.before = result.tokensBefore
  if (typeof result.tokensAfter === 'number') next.after = result.tokensAfter
  return next
}

/** "hace 40 s", "hace 5 min", "hace 2 h", "hace 3 d". */
export const agoLabel = (ms: number): string => {
  const secs = Math.max(0, Math.round(ms / 1000))
  if (secs < 60) return `hace ${secs} s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `hace ${mins} min`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `hace ${hours} h` : `hace ${Math.round(hours / 24)} d`
}

export const compactionLabel = (record: CompactionRecord, now: number): string => {
  if (record.count === 0) return 'Sin compactaciones en esta sesión'
  const times = record.count === 1 ? '1 vez' : `${record.count} veces`
  const parts = [`Compactado ${times}`]
  if (record.lastAt > 0) parts.push(`última ${agoLabel(now - record.lastAt)}`)
  if (record.before !== undefined && record.after !== undefined) parts.push(`${compact(record.before)}→${compact(record.after)}`)
  return parts.join(' · ')
}

/** The live fill against the session's measured window; the breakdown's own figure only before a response came back. */
export const livePercent = (part: Pick<ContextPart, 'usage' | 'breakdown'>): number | undefined => {
  const measured = contextPercentOf(againstCompaction(part.usage, part.breakdown.window))
  if (measured !== undefined) return measured
  const { total, window } = part.breakdown
  return window > 0 && total > 0 ? (total / window) * 100 : undefined
}

const miniBar = (percent: number): string => {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round((percent / 100) * BAR_CELLS)))
  return '▰'.repeat(filled) + '▱'.repeat(BAR_CELLS - filled)
}

const ROW_TONE: Record<ContextRowKind, Tone | undefined> = { used: undefined, free: 'subtle', buffer: 'subtle' }

/** Below these widths a breakdown row sheds its bar, then its percent. */
const BAR_FROM = 29
const PERCENT_FROM = 20
const INDENT_FROM = 12

/** Which parts of a breakdown row fit, and how wide its name is; the whole row is never wider than `width`. */
export const breakdownLayout = (width: number): { indent: string; nameWidth: number; hasPercent: boolean; hasBar: boolean } => {
  if (width >= BAR_FROM) return { indent: '  ', nameWidth: Math.max(6, Math.min(26, width - (BAR_CELLS + 16))), hasPercent: true, hasBar: true }
  if (width >= PERCENT_FROM) return { indent: '  ', nameWidth: Math.min(26, width - 14), hasPercent: true, hasBar: false }
  const indent = width >= INDENT_FROM ? '  ' : ''
  return { indent, nameWidth: Math.max(1, width - indent.length - 5), hasPercent: false, hasBar: false }
}

export const rowsContext = (
  part: ContextPart,
  ctx: { width: number; accent: string; isOpen: (key: string, byDefault: boolean) => boolean },
): Row[] => {
  const width = Math.max(1, ctx.width)
  const { breakdown, compactions } = part
  const percent = livePercent(part)
  const headParts = ['Contexto']
  if (breakdown.window > 0) headParts.push(`${compact(breakdown.total)} / ${compact(breakdown.window)}`)
  if (percent !== undefined) headParts.push(`${Math.round(percent)} %`)
  if (compactions.count > 0) headParts.push(`${compactions.count}× compactado`)
  const label = headParts.join(' · ')
  const open = ctx.isOpen(SECTION_KEY, true)
  const header: Row = {
    key: SECTION_KEY,
    cells: [{ spans: [span(fit(`${open ? '▼' : '▶'} ${label}`, width))], action: { kind: 'toggle', key: SECTION_KEY }, label, key: `btn-${SECTION_KEY}` }],
  }
  if (!open) return [header]

  const line = (key: string, value: string, style: Omit<Span, 'text'> = {}): Row => ({ key, cells: [{ spans: [span(fit(value, width), style)] }] })
  const body: Row[] = []
  if (breakdown.rows.length === 0 || breakdown.window <= 0) {
    body.push(line('ctxb-empty', '  Desglose aún sin medir', { dim: true }))
  } else {
    const ordered = [
      ...breakdown.rows.filter(row => row.kind === 'used'),
      ...breakdown.rows.filter(row => row.kind === 'free'),
      ...breakdown.rows.filter(row => row.kind === 'buffer'),
    ]
    const layout = breakdownLayout(width)
    ordered.forEach((row, index) => {
      const share = (row.tokens / breakdown.window) * 100
      const name = fit(contextLabelOf(row.name), layout.nameWidth).padEnd(layout.nameWidth)
      const tokens = compact(row.tokens).padStart(layout.hasPercent ? 6 : 5)
      const percent = layout.hasPercent ? ` ${`${Math.round(share)} %`.padStart(5)}` : ''
      const figures = `${tokens}${percent}${layout.hasBar ? ' ' : ''}`
      const dim = row.kind !== 'used'
      const tone = ROW_TONE[row.kind]
      body.push({
        key: `ctxb-row-${index}`,
        cells: [{
          spans: [
            span(`${layout.indent}${name}`, { dim }),
            span(figures, { dim }),
            ...(layout.hasBar ? [span(miniBar(share), dim ? { dim, ...(tone ? { color: tone } : {}) } : { color: ctx.accent })] : []),
          ],
        }],
      })
    })
    if (breakdown.autoCompactAt !== undefined) {
      body.push(line('ctxb-threshold', `  Compacta al llegar a ${compact(breakdown.autoCompactAt)} tokens`, { dim: true }))
    }
  }
  body.push(line('ctxb-compactions', `  ${compactionLabel(compactions, part.now)}`, compactions.count > 0 ? {} : { dim: true }))
  return [header, ...body]
}

export const footerContext = (part: Pick<ContextPart, 'usage' | 'breakdown'>): Span[] => {
  const measured = livePercent(part)
  if (measured === undefined) return []
  const percent = Math.round(measured)
  if (percent < WARN_PERCENT) return []
  const isError = percent >= ERROR_PERCENT
  return [span(`⚠ ${percent} % · se compactará pronto`, { color: isError ? 'error' : 'warning', bold: isError })]
}

/** The session's live figures as the pane stores them: numbers only, no breakdown. */
export const liveOf = (usage: SessionContextUsage): ContextPart['usage'] => {
  const live: ContextPart['usage'] = { window: usage.window }
  if (usage.tokens !== undefined) live.tokens = usage.tokens
  if (usage.percent !== undefined) live.percent = usage.percent
  return live
}

/** Atoms only: the live figures arrive through `session.measure` and the refreshes below, never from a draw. */
export async function readContext($: Api): Promise<ContextPart> {
  const [breakdown, compactions, usage, now] = await Promise.all([
    read($, breakdownAtom).catch(() => EMPTY_BREAKDOWN),
    read($, compactionsAtom).catch(() => EMPTY_COMPACTIONS),
    read($, liveAtom).catch(() => EMPTY_LIVE),
    $.clock.now().catch(() => 0),
  ])
  return { breakdown, compactions, usage, now }
}

/** `session.measure` pushes what `$.session.usage()` would answer: kept so a draw never asks. */
export async function contextMeasured($: Api, usage: SessionContextUsage): Promise<void> {
  await update($, liveAtom, () => liveOf(usage))
}

/** One `$.session.usage` read per event: the live figures always, the breakdown when forced or due. */
async function refreshContext($: Api, force: boolean): Promise<void> {
  const now = await $.clock.now()
  if (refreshing) return
  const isDue = force || now - lastRefreshAt >= REFRESH_MS
  if (isDue) lastRefreshAt = now
  refreshing = (async () => {
    const found = await $.session.usage(isDue ? { breakdown: 'summary' } : undefined)
    await update($, liveAtom, () => liveOf(found.context))
    const raw = found.context.breakdown
    if (isDue && raw) await update($, breakdownAtom, () => breakdownOf(raw, now))
  })()
    .catch(() => undefined)
    .finally(() => {
      refreshing = undefined
    })
  await refreshing
}

/** The live figures now, the breakdown when due: for a pane opened before any event filled them. */
export async function contextKick($: Api): Promise<void> {
  await refreshContext($, false)
}

export const registerContext = (on: On): void => {


  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    try {
      const at = await $.clock.now()
      await update($, compactionsAtom, record => recordCompaction(record, result, e.trigger, at))
      if (result.skip === undefined && e.trigger !== 'precompute') void refreshContext($ as Api, true).catch(() => undefined)
    } catch {
      // Bookkeeping only: the compaction stands either way.
    }
    return result
  })
}

export async function contextSessionStart($: Api, e: Parameters<Hook<'session.start'>>[1], next: Parameters<Hook<'session.start'>>[2]): Promise<Awaited<ReturnType<Hook<'session.start'>>>> {
  const result = await next(e)
  void refreshContext($ as Api, true).catch(() => undefined)
  return result
}

export async function contextTurnComplete($: Api, e: Parameters<Hook<'turn.complete'>>[1], next: Parameters<Hook<'turn.complete'>>[2]): Promise<Awaited<ReturnType<Hook<'turn.complete'>>>> {
  const result = await next(e)
  if (e.agentId === undefined) void refreshContext($, false).catch(() => undefined)
  return result
}
