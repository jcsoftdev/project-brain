import type { Hook } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRecord } from '../types'
import type { Action, Api, Cell, Look, Row, Span, Tone } from './register'
import { AGENT_LOOK, ICONS, MAIN, clean, fit, shortName, span } from './register'

// Values from './register' are used only inside functions: the import is circular.

const REPORT_CHARS = 4096
const REPORTS_KEPT = 30
const PREVIEW_LINES = 6
const MARKER_ROOM = 2 * 5

const expandedAtom = atom({ plugin: 'project-brain-activity', key: 'agentsExpanded' } as const, false, { shape: 'agentsExpanded-1' })
const reportsAtom = atom({ plugin: 'project-brain-activity', key: 'agentsReports' } as const, {} as Record<string, string>, { shape: 'agentsReports-1' })

/** The toggle that shows or hides the ended agents' chips. */
export type AgentsAction = { kind: 'agents'; op: 'toggle' }

/** A header cell whose action may be this feature's own, until `Action` carries `AgentsAction`. */
export type AgentsCell = Omit<Cell, 'action'> & { action?: Action | AgentsAction }

export type AgentsPart = { expanded: boolean; reports: Record<string, string> }

export type GroupedInput = { records: AgentRecord[]; scope: string; expanded: boolean; width: number }

export type Verdict = { token: string; tone: Tone }

const isEnded = (record: AgentRecord): boolean => record.state !== 'running'

const newestFirst = (a: AgentRecord, b: AgentRecord): number => b.startedAt - a.startedAt

const widthOf = (cell: AgentsCell): number => cell.spans.reduce((sum, one) => sum + [...one.text].length, 0)

const chipOf = (key: string, label: string, isOn: boolean, action: Action, look?: Look): AgentsCell => ({
  key,
  label,
  action,
  spans: [
    span(` ${label} `, { inverse: isOn, bold: isOn }),
    ...(look ? [span(`${look.icon} `, { color: look.color, inverse: isOn })] : []),
    span(' '),
  ],
})

const toggleOf = (ended: AgentRecord[], expanded: boolean): AgentsCell => {
  const done = ended.filter(one => one.state === 'done').length
  const failed = ended.length - done
  const parts: Span[] = []
  if (done > 0) parts.push(span(`${ICONS.ok} ${done}`, { color: 'success', bold: expanded }))
  if (done > 0 && failed > 0) parts.push(span(' · ', { dim: true }))
  if (failed > 0) parts.push(span(`${ICONS.error} ${failed}`, { color: 'error', bold: expanded }))
  return {
    key: 'agents-toggle',
    label: expanded ? 'Ocultar terminados' : 'Mostrar terminados',
    action: { kind: 'agents', op: 'toggle' },
    spans: [span(expanded ? ' ▾ ' : ' ▸ ', { color: 'suggestion' }), ...parts, span('  ')],
  }
}

/**
 * The cells that fit one row: the pinned cells stay, the chips scroll as a window that always holds
 * the selected one. Hidden chips collapse into "‹ N" / "N ›" markers that select the nearest hidden agent.
 * The same windowing as `agentStrip`, for more than one pinned cell.
 */
const windowed = (pinned: AgentsCell[], chips: AgentsCell[], selected: number, ids: string[], width: number): AgentsCell[] => {
  const pinnedWidth = pinned.reduce((sum, one) => sum + widthOf(one), 0)
  const total = pinnedWidth + chips.reduce((sum, one) => sum + widthOf(one), 0)
  if (total <= width) return [...pinned, ...chips]
  const room = width - pinnedWidth - MARKER_ROOM
  if (room <= 0 || chips.length === 0) return pinned
  const marker = (text: string, id: string, key: string): AgentsCell => ({
    key,
    label: text.trim(),
    action: { kind: 'agent', id },
    spans: [span(text, { color: 'suggestion', bold: true })],
  })
  let start = Math.max(0, selected)
  let end = start
  let used = 0
  const fits = (index: number) => used + widthOf(chips[index] as AgentsCell) <= room
  while (end < chips.length && (end === start || fits(end))) used += widthOf(chips[end++] as AgentsCell)
  while (start > 0 && fits(start - 1)) used += widthOf(chips[--start] as AgentsCell)
  return [
    ...pinned,
    ...(start > 0 ? [marker(`‹ ${start} `, ids[start - 1] ?? MAIN, 'agents-left')] : []),
    ...chips.slice(start, end),
    ...(end < chips.length ? [marker(` ${chips.length - end} ›`, ids[end] ?? MAIN, 'agents-right')] : []),
  ]
}

/**
 * The agent chips grouped: "Principal" and the ended agents' toggle stay pinned; running agents follow,
 * newest first; ended agents show after them only when expanded. The selected agent is always shown.
 */
export const agentChipsGrouped = ({ records, scope, expanded, width }: GroupedInput): AgentsCell[] => {
  const live = records.filter(one => !isEnded(one)).sort(newestFirst)
  const ended = records.filter(isEnded).sort(newestFirst)
  const shownEnded = expanded ? ended : ended.filter(one => one.id === scope)
  const visible = [...live, ...shownEnded]
  const principal = chipOf(`agents-chip-${MAIN}`, 'Principal', scope === MAIN, { kind: 'agent', id: MAIN })
  const pinned = ended.length > 0 ? [principal, toggleOf(ended, expanded)] : [principal]
  const chips = visible.map(one => chipOf(`agents-chip-${one.id}`, shortName(one), scope === one.id, { kind: 'agent', id: one.id }, AGENT_LOOK[one.state]))
  return windowed(pinned, chips, visible.findIndex(one => one.id === scope), visible.map(one => one.id), Math.max(1, width))
}

const VERDICT_LINE = /^[\s#>*_`-]*(?:verdict|veredicto)[*_`]*\s*[:：]\s*[*_`]*\s*([A-Za-z][A-Za-z_-]*)/im

const VERDICT_TONES: Record<string, Tone> = {
  PASS: 'success', PASSED: 'success', OK: 'success', APPROVED: 'success', APPROVE: 'success', SUCCESS: 'success', DONE: 'success',
  FAIL: 'error', FAILED: 'error', REJECTED: 'error', REJECT: 'error', ERROR: 'error',
  PARTIAL: 'warning', BLOCKED: 'warning', WARN: 'warning', WARNING: 'warning', INCONCLUSIVE: 'warning',
}

/** The token of a "Verdict:" line, wherever the report puts it; markdown emphasis around it is ignored. */
export const verdictIn = (text: string): Verdict | undefined => {
  const found = VERDICT_LINE.exec(text)?.[1]
  if (found === undefined) return undefined
  const token = found.toUpperCase().replace(/-/g, '_').slice(0, 16)
  return { token, tone: VERDICT_TONES[token] ?? 'subtle' }
}

/** The report kept for an agent: cleaned, cut to its first 4 KB of characters. */
export const boundReport = (raw: string): string => {
  const cleaned = clean(raw).trim()
  const chars = [...cleaned]
  return chars.length <= REPORT_CHARS ? cleaned : chars.slice(0, REPORT_CHARS).join('')
}

/** The first lines of an ended agent's report and its verdict; nothing for a running agent or one with no report. */
export const rowsAgentReport = (record: AgentRecord | undefined, report: string | undefined, width: number): Row[] => {
  if (record === undefined || !isEnded(record) || report === undefined || report.trim() === '') return []
  const verdict = verdictIn(report)
  const lines = report.split('\n').map(one => one.trimEnd()).filter(one => one.trim() !== '' && !VERDICT_LINE.test(one))
  const shown = lines.slice(0, PREVIEW_LINES)
  const room = Math.max(1, width - 2)
  const head: Row = {
    key: 'agents-report-head',
    cells: [{ spans: [span(`${ICONS.log} Informe`, { bold: true })] }],
    ...(verdict ? { right: [span(` ${verdict.token} `, { color: verdict.tone, bold: true })] } : {}),
  }
  const body: Row[] = shown.map((one, index) => ({ key: `agents-report-${index}`, cells: [{ spans: [span(`  ${fit(clean(one), room)}`, { dim: true })] }] }))
  const more = lines.length - shown.length
  return [
    head,
    ...body,
    ...(more > 0 ? [{ key: 'agents-report-more', cells: [{ spans: [span(`  … ${more} ${more === 1 ? 'línea más' : 'líneas más'}`, { color: 'subtle' })] }] }] : []),
  ]
}

export async function readAgents($: Api): Promise<AgentsPart> {
  const [expanded, reports] = await Promise.all([read($, expandedAtom), read($, reportsAtom)])
  return { expanded, reports }
}

export async function actAgents($: Api, action: AgentsAction): Promise<void> {
  if (action.op === 'toggle') await update($, expandedAtom, isOn => !isOn)
}

/** Keeps the latest report of each agent, the newest `REPORTS_KEPT` agents only. */
export const keepReport = (all: Record<string, string>, agentId: string, report: string): Record<string, string> =>
  Object.fromEntries([...Object.entries(all).filter(([id]) => id !== agentId), [agentId, report]].slice(-REPORTS_KEPT))

export const registerAgents = (on: Parameters<Register>[0]): void => {
}

export async function agentsTurnComplete($: Api, e: Parameters<Hook<'turn.complete'>>[1], next: Parameters<Hook<'turn.complete'>>[2]): Promise<Awaited<ReturnType<Hook<'turn.complete'>>>> {
  const done = await next(e)
  try {
    const agentId = e.agentId
    const report = agentId === undefined ? '' : boundReport(e.answer)
    if (agentId !== undefined && report !== '') await update($, reportsAtom, all => keepReport(all, agentId, report))
  } catch {
    // A lost preview never costs the turn its result.
  }
  return done
}
