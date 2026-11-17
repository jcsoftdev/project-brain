import type { Hook } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Api, Row, Span, Tone } from './register'
import { ICONS, agentUsage, clean, fit, shortName, span, usageRight } from './register'
import type { AgentUsage } from '../types'
import { notify } from './feat-notify'

export type RunningKind = 'bash' | 'monitor' | 'agent' | 'workflow'
export type RunningStatus = 'running' | 'completed' | 'failed' | 'killed'

/** One piece of background work: a backgrounded shell, a Monitor watch, a background agent or a workflow. */
export type RunningTask = {
  id: string
  kind: RunningKind
  label: string
  status: RunningStatus
  startedAt: number
  endedAt?: number
  /** The loop that started it; absent for the main conversation. */
  agentId?: string
  agentLabel?: string
  toolUseId?: string
  /** Only ever a path the engine reported for this task. */
  outputFile?: string
  lastLine?: string
  exitCode?: number
  /** A Monitor's kill deadline, when it has one. */
  deadline?: number
  /** Ended without a notification: the session's in-flight list no longer named it. */
  isInferred?: boolean
}

/** `usage` is keyed by agent id: a background agent's task id is the agent id its model requests report. */
export type RunningPart = { tasks: RunningTask[]; now: number; usage?: Record<string, AgentUsage> }

/** What a background-launching tool call reported. */
export type Launch = Pick<RunningTask, 'id' | 'kind' | 'label'> & Partial<Pick<RunningTask, 'outputFile' | 'deadline'>>

/** One `<task-notification>` block, its fields unescaped; `status` absent on a Monitor's mid-stream event. */
export type Notice = { id: string; toolUseId?: string; status?: string; summary?: string; event?: string; outputFile?: string; exitCode?: number }

type On = Parameters<Register>[0]

const KEEP = 50
const LINGER_MS = 10 * 60_000
const TICK_MS = 3000
const TAIL_BYTES = 64 * 1024
const TAILS_PER_TICK = 8
const LINE_MAX = 300
const LABEL_MAX = 200
const MONITOR_GRACE_MS = 15_000
const STOP_GRACE_MS = 5000
const SECTION_KEY = 'running-section'
const TASK_ID = /^[A-Za-z0-9_-]{4,64}$/
const OUTPUT_PATH = /^\/(?:[^\0/]+\/)+tasks\/[A-Za-z0-9_-]{4,64}\.output$/
const NOTICE_DOORS = new Set(['prompt', 'delivery', 'attachment', 'queue', 'hook-context', 'notice'])

const tasksAtom = atom({ plugin: 'project-brain-activity', key: 'runningTasks' } as const, [] as RunningTask[], { shape: 'running-tasks-1' })
const tickAtom = atom({ plugin: 'project-brain-activity', key: 'runningTick' } as const, 0, { shape: 'running-tick-1' })

// A reload drops these; session.start restarts the timer when work is still running.
let ticker: { cancel: () => void } | undefined
let ticking = false
const tailMtime = new Map<string, number>()

// ---------------------------------------------------------------- parsing

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

const oneLine = (raw: string, max: number): string => fit(clean(raw).replace(/\s+/g, ' ').trim(), max)

const unescape = (value: string): string =>
  value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

const safeId = (value: unknown): string | undefined => {
  const id = str(value)?.trim()
  return id !== undefined && TASK_ID.test(id) ? id : undefined
}

/** A task output path as the engine wrote it; anything else is refused. */
export const safeOutputPath = (value: unknown): string | undefined => {
  const path = str(value)?.trim()
  return path !== undefined && OUTPUT_PATH.test(path) && !path.split('/').includes('..') ? path : undefined
}

/** The exit code a notification's summary or event names: `(exit code 0)`, `failed with exit code 1`, `[exited with code 1]`. */
export const exitCodeIn = (text: string): number | undefined => {
  const match = /exit(?:ed)? (?:with )?code (\d{1,3})/i.exec(text)
  return match ? Number(match[1]) : undefined
}

/** Reads what a tool call that may have started background work reported. */
export const launchOf = (tool: string, input: Record<string, unknown>, result: unknown, text: string | undefined, startedAt: number): Launch | undefined => {
  const record = (result ?? {}) as Record<string, unknown>
  if (tool === 'Bash') {
    const id = safeId(record.backgroundTaskId)
    if (id === undefined) return undefined
    const written = /Output is being written to: (\S+?\.output)\b/.exec(text ?? '')?.[1]
    const outputFile = safeOutputPath(record.backgroundOutputPath) ?? safeOutputPath(written)
    const label = oneLine(str(input.description) ?? str(input.command) ?? 'comando', LABEL_MAX)
    return { id, kind: 'bash', label, ...(outputFile === undefined ? {} : { outputFile }) }
  }
  if (tool === 'Monitor') {
    const id = safeId(record.taskId)
    if (id === undefined) return undefined
    const timeoutMs = typeof record.timeoutMs === 'number' && record.timeoutMs > 0 && record.persistent !== true ? record.timeoutMs : undefined
    const label = oneLine(str(input.description) ?? str(input.command) ?? 'monitor', LABEL_MAX)
    return { id, kind: 'monitor', label, ...(timeoutMs === undefined ? {} : { deadline: startedAt + timeoutMs }) }
  }
  if (tool === 'Agent') {
    const status = record.status
    const id = status === 'async_launched' ? safeId(record.agentId) : status === 'remote_launched' ? safeId(record.taskId) : undefined
    if (id === undefined) return undefined
    return { id, kind: 'agent', label: oneLine(str(record.description) ?? str(input.description) ?? 'agente', LABEL_MAX) }
  }
  if (tool === 'Workflow') {
    const id = safeId(record.taskId)
    if (id === undefined || (record.status !== 'async_launched' && record.status !== 'remote_launched')) return undefined
    return { id, kind: 'workflow', label: oneLine(str(record.workflowName) ?? str(record.summary) ?? 'workflow', LABEL_MAX) }
  }
  return undefined
}

const tag = (block: string, name: string): string | undefined => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)
  return match ? unescape(match[1] ?? '').trim() : undefined
}

/** Every `<task-notification>` block in a row's text. */
export const parseNotices = (text: string): Notice[] => {
  if (!text.includes('<task-notification>')) return []
  const found: Notice[] = []
  for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const block = match[1] ?? ''
    const id = safeId(tag(block, 'task-id'))
    if (id === undefined) continue
    const notice: Notice = { id }
    const toolUseId = tag(block, 'tool-use-id')
    const status = tag(block, 'status')
    const summary = tag(block, 'summary')
    const event = tag(block, 'event')
    const outputFile = safeOutputPath(tag(block, 'output-file'))
    if (toolUseId) notice.toolUseId = toolUseId
    if (status) notice.status = status.toLowerCase()
    if (summary) notice.summary = summary
    if (event) notice.event = event
    if (outputFile) notice.outputFile = outputFile
    const exitCode = exitCodeIn(`${summary ?? ''} ${event ?? ''}`)
    if (exitCode !== undefined) notice.exitCode = exitCode
    found.push(notice)
  }
  return found
}

/** A notification's word as one of ours: `stopped` reads as killed; an unknown word as completed. */
export const statusOf = (word: string | undefined, exitCode: number | undefined): RunningStatus | undefined => {
  if (word === undefined) return undefined
  if (word === 'failed' || word === 'error') return 'failed'
  if (word === 'killed' || word === 'stopped' || word === 'cancelled') return 'killed'
  return exitCode !== undefined && exitCode !== 0 ? 'failed' : 'completed'
}

/** The last non-empty line of an output tail, bounded and stripped of escapes. */
export const lastLineOf = (tail: string): string | undefined => {
  const lines = tail.replace(/\r/g, '\n').split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = oneLine(lines[index] ?? '', LINE_MAX)
    if (line !== '') return line
  }
  return undefined
}

// ---------------------------------------------------------------- list model

const end = (task: RunningTask, status: RunningStatus, now: number, extra: Partial<RunningTask> = {}): RunningTask => ({ ...task, ...extra, status, endedAt: now })

/** Adds or replaces a task by id, then prunes. */
export const addTask = (list: RunningTask[], task: RunningTask, now: number): RunningTask[] => prune([...list.filter(one => one.id !== task.id), task], now)

/** Applies one notification; `ended` lists the tasks it finished, for the toast. Unknown ids are ignored. */
export const applyNotice = (list: RunningTask[], notice: Notice, now: number): { list: RunningTask[]; ended: RunningTask[] } => {
  const ended: RunningTask[] = []
  const next = list.map(task => {
    if (task.id !== notice.id && (notice.toolUseId === undefined || task.toolUseId !== notice.toolUseId)) return task
    if (task.status !== 'running') return task
    const lastLine = notice.event !== undefined ? lastLineOf(notice.event) : undefined
    const extra: Partial<RunningTask> = {
      ...(lastLine === undefined ? {} : { lastLine }),
      ...(task.outputFile === undefined && notice.outputFile !== undefined && task.kind === 'bash' ? { outputFile: notice.outputFile } : {}),
    }
    const status = statusOf(notice.status, notice.exitCode)
    if (status === undefined) return { ...task, ...extra }
    const done = end(task, status, now, { ...extra, ...(notice.exitCode === undefined ? {} : { exitCode: notice.exitCode }) })
    ended.push(done)
    return done
  })
  return { list: next, ended }
}

/** Ends the main loop's shells and monitors the session no longer lists as in flight. */
export const reconcileInFlight = (list: RunningTask[], inFlight: string[], now: number): { list: RunningTask[]; ended: RunningTask[] } => {
  const live = new Set(inFlight)
  const ended: RunningTask[] = []
  const next = list.map(task => {
    const isCandidate = task.status === 'running' && task.agentId === undefined && (task.kind === 'bash' || task.kind === 'monitor')
    if (!isCandidate || live.has(task.id) || now - task.startedAt < STOP_GRACE_MS) return task
    const done = end(task, 'completed', now, { isInferred: true })
    ended.push(done)
    return done
  })
  return { list: next, ended }
}

/** Ends Monitors past their deadline, and background agents the session lists as ended. */
export const expireTasks = (list: RunningTask[], agentStatus: Record<string, string>, now: number): { list: RunningTask[]; ended: RunningTask[] } => {
  const ended: RunningTask[] = []
  const next = list.map(task => {
    if (task.status !== 'running') return task
    if (task.kind === 'monitor' && task.deadline !== undefined && now > task.deadline + MONITOR_GRACE_MS) {
      const done = end(task, 'completed', now, { isInferred: true })
      ended.push(done)
      return done
    }
    const word = task.kind === 'agent' ? agentStatus[task.id] : undefined
    if (word === 'completed' || word === 'failed' || word === 'killed') {
      const done = end(task, word, now)
      ended.push(done)
      return done
    }
    return task
  })
  return { list: next, ended }
}

/** Drops finished tasks older than ten minutes, then keeps the newest fifty, running ones first. */
export const prune = (list: RunningTask[], now: number): RunningTask[] => {
  const kept = list.filter(task => task.status === 'running' || now - (task.endedAt ?? now) <= LINGER_MS)
  if (kept.length <= KEEP) return kept
  const running = kept.filter(task => task.status === 'running').slice(-KEEP)
  const finished = kept.filter(task => task.status !== 'running').slice(-(KEEP - running.length))
  const keep = new Set([...running, ...finished])
  return kept.filter(task => keep.has(task))
}

export const isRunning = (task: RunningTask): boolean => task.status === 'running'

// ---------------------------------------------------------------- drawing

/** `12 s`, `2m 05s`, `1h 03m`. */
export const elapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total} s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

const kindIcon = (kind: RunningKind): string =>
  kind === 'bash' ? ICONS.command : kind === 'monitor' ? ICONS.gauge : kind === 'agent' ? ICONS.agent : ICONS.branch

const DONE_LOOK: Record<Exclude<RunningStatus, 'running'>, { icon: string; color: Tone }> = {
  completed: { icon: '✓', color: 'success' },
  failed: { icon: '✗', color: 'error' },
  killed: { icon: '◼', color: 'subtle' },
}

/** PASS/FAIL once a task ended with a verdict to give; a killed or inferred end gives none. */
export const verdictOfTask = (task: RunningTask): 'PASS' | 'FAIL' | undefined => {
  if (task.status === 'failed') return 'FAIL'
  if (task.status === 'completed' && !task.isInferred) return task.exitCode === undefined || task.exitCode === 0 ? 'PASS' : 'FAIL'
  return undefined
}

const visible = (part: RunningPart): RunningTask[] => {
  const shown = part.tasks.filter(task => task.status === 'running' || part.now - (task.endedAt ?? part.now) <= LINGER_MS)
  return [...shown.filter(isRunning), ...shown.filter(task => !isRunning(task)).reverse()].slice(0, KEEP)
}

export const rowsRunning = (part: RunningPart, ctx: { width: number; accent: string; isOpen: (key: string, byDefault: boolean) => boolean }): Row[] => {
  const shown = visible(part)
  if (shown.length === 0) return []
  const width = Math.max(10, ctx.width)
  const live = shown.filter(isRunning).length
  const open = ctx.isOpen(SECTION_KEY, true)
  const title = `${open ? '▼' : '▶'} ◷ En curso · ${live}`
  const rows: Row[] = [{
    key: SECTION_KEY,
    cells: [{ spans: [span(fit(title, width), { bold: true, color: live > 0 ? ctx.accent : undefined })], action: { kind: 'toggle', key: SECTION_KEY }, label: 'En curso', key: `btn-${SECTION_KEY}` }],
  }]
  if (!open) return rows
  const usageOf = (task: RunningTask, base: string): string => (task.kind === 'agent' ? usageRight(part.usage?.[task.id], base, width) : '')
  const withUsage = (spent: string, right: Span[]): Span[] => (spent === '' ? right : [span(spent, { dim: true }), ...right])
  for (const task of shown) {
    const who = task.agentLabel !== undefined ? `${clean(task.agentLabel)} · ` : ''
    const label = clean(task.label)
    if (task.status === 'running') {
      const right = elapsed(part.now - task.startedAt)
      const spent = usageOf(task, right)
      rows.push({
        key: `running-${task.id}`,
        cells: [{ spans: [span(`  ${ICONS.running} `, { color: 'warning' }), span(`${kindIcon(task.kind)} ${fit(label, width - spent.length - right.length - 8)}`)] }],
        right: withUsage(spent, [span(right, { color: 'warning' })]),
      })
      const detail = `${who}${clean(task.lastLine ?? '')}`
      if (detail !== '') rows.push({ key: `running-${task.id}-line`, cells: [{ spans: [span(fit(`      └ ${detail}`, width), { dim: true })] }] })
      continue
    }
    const look = DONE_LOOK[task.status]
    const verdict = verdictOfTask(task)
    const took = elapsed((task.endedAt ?? part.now) - task.startedAt)
    const rightText = verdict ? `${verdict} ${took}` : took
    const spent = usageOf(task, rightText)
    rows.push({
      key: `running-${task.id}`,
      cells: [{ spans: [span(`  ${look.icon} `, { color: look.color }), span(`${kindIcon(task.kind)} ${fit(`${who}${label}`, width - spent.length - rightText.length - 8)}`, { dim: true })] }],
      right: withUsage(spent, verdict ? [span(verdict, { color: verdict === 'PASS' ? 'success' : 'error' }), span(` ${took}`, { dim: true })] : [span(took, { dim: true })]),
    })
  }
  return rows
}

/** `◷ 2 en curso` for the pane's title row; nothing when no work is running. */
export const headerRunning = (part: RunningPart): Span[] => {
  const live = part.tasks.filter(isRunning).length
  return live === 0 ? [] : [span(`◷ ${live} en curso`, { color: 'warning' })]
}

/** The toast a finished task raises. */
export const toastOf = (task: RunningTask): string => {
  const took = elapsed((task.endedAt ?? task.startedAt) - task.startedAt)
  const label = fit(clean(task.label), 60)
  if (task.status === 'failed') return `✗ Falló: ${label}${task.exitCode !== undefined ? ` (código ${task.exitCode})` : ''} · ${took}`
  if (task.status === 'killed') return `◼ Detenida: ${label} · ${took}`
  return `✓ Terminó: ${label} · ${took}`
}

const KIND_NAME: Record<RunningKind, string> = { bash: 'Comando', monitor: 'Monitor', agent: 'Agente', workflow: 'Workflow' }

/** The one-line OS notification a finished task raises: what it was, how it ended, its verdict. */
export const notifyLineOf = (task: RunningTask): string => {
  const took = elapsed((task.endedAt ?? task.startedAt) - task.startedAt)
  const what = `${KIND_NAME[task.kind]} '${fit(clean(task.label), 60)}'`
  if (task.status === 'killed') return `◼ ${what} se detuvo · ${took}`
  const verdict = verdictOfTask(task)
  const code = task.status === 'failed' && task.exitCode !== undefined ? ` (código ${task.exitCode})` : ''
  const ok = verdict !== 'FAIL'
  return `${ok ? '✓' : '✗'} ${what} ${ok ? 'terminó' : 'falló'}${code}${verdict ? ` · ${verdict}` : ''} · ${took}`
}

// ---------------------------------------------------------------- engine

export async function readRunning($: Api): Promise<RunningPart> {
  const [tasks, now, , usage] = await Promise.all([read($, tasksAtom), $.clock.now(), read($, tickAtom), read($, agentUsage)])
  return { tasks, now, usage }
}

function announce($: Api, ended: RunningTask[]): void {
  for (const task of ended) {
    if (task.isInferred) continue
    try {
      $.ui.toast(toastOf(task), { timeoutMs: 6000 })
    } catch {
      // A refused toast loses only the toast.
    }
    void notify($, { key: `task:${task.id}`, text: notifyLineOf(task) }).catch(() => undefined)
  }
}

/** Reads the last output line of a running shell from its engine-reported file, at most 64 KB of its tail. */
async function tailLine($: Api, path: string): Promise<string | undefined> {
  const stat = await $.fs.stat(path)
  if (stat.kind !== 'file') return undefined
  if (tailMtime.get(path) === stat.mtimeMs) return undefined
  tailMtime.set(path, stat.mtimeMs)
  if (stat.size === 0) return undefined
  if (stat.size <= TAIL_BYTES) return lastLineOf(await $.fs.read(path))
  const out = await $.process.run(['/usr/bin/tail', '-c', String(TAIL_BYTES), path], { timeoutMs: 2000 })
  return out.exitCode === 0 ? lastLineOf(out.stdout.slice(-TAIL_BYTES)) : undefined
}

async function tick($: Api): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const before = await read($, tasksAtom)
    const running = before.filter(isRunning)
    if (running.length === 0) {
      ticker?.cancel()
      ticker = undefined
      return
    }
    const lines: Record<string, string> = {}
    for (const task of running.filter(one => one.kind === 'bash' && one.outputFile !== undefined).slice(0, TAILS_PER_TICK)) {
      const line = await tailLine($, task.outputFile as string).catch(() => undefined)
      if (line !== undefined) lines[task.id] = line
    }
    const agentStatus: Record<string, string> = {}
    if (running.some(one => one.kind === 'agent')) for (const info of await $.agent.list().catch(() => [])) agentStatus[info.id] = info.status
    const now = await $.clock.now()
    let ended: RunningTask[] = []
    await update($, tasksAtom, list => {
      const withLines = list.map(task => (task.status === 'running' && lines[task.id] !== undefined ? { ...task, lastLine: lines[task.id] } : task))
      const expired = expireTasks(withLines, agentStatus, now)
      ended = expired.ended
      return prune(expired.list, now)
    })
    await update($, tickAtom, () => now)
    announce($, ended)
  } finally {
    ticking = false
  }
}

function ensureTicker($: Api): void {
  if (ticker !== undefined) return
  ticker = $.clock.every(TICK_MS, () => {
    void tick($).catch(() => undefined)
  })
}

async function agentLabelOf($: Api, agentId: string | undefined): Promise<string | undefined> {
  if (agentId === undefined) return undefined
  const info = (await $.agent.list().catch(() => [])).find(one => one.id === agentId)
  return info ? oneLine(shortName({ description: info.description, ...(info.name ? { name: info.name } : {}) }), 16) : 'agente'
}

const textOfBlocks = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '')).join('\n')
}

async function onNotices($: Api, notices: Notice[]): Promise<void> {
  const now = await $.clock.now()
  let ended: RunningTask[] = []
  await update($, tasksAtom, list => {
    let next = list
    for (const notice of notices) {
      const applied = applyNotice(next, notice, now)
      next = applied.list
      ended = [...ended, ...applied.ended]
    }
    return ended.length === 0 && next === list ? list : prune(next, now)
  })
  announce($, ended)
}

export const registerRunning = (on: On): void => {


  on('session.append', async ($, e, next) => {
    try {
      if (NOTICE_DOORS.has(e.door) && e.message.type !== 'assistant') {
        const notices = parseNotices(textOfBlocks(e.message.content))
        if (notices.length > 0) await onNotices($ as Api, notices)
      }
    } catch {
      // A notice the pane missed leaves the row running until the next reconcile.
    }
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    try {
      const inFlight = e.background_tasks
      if (Array.isArray(inFlight)) {
        const now = await $.clock.now()
        let ended: RunningTask[] = []
        await update($, tasksAtom, list => {
          const reconciled = reconcileInFlight(list, inFlight.map(one => one.id), now)
          ended = reconciled.ended
          return reconciled.ended.length === 0 ? list : prune(reconciled.list, now)
        })
        announce($ as Api, ended)
      }
    } catch {
      // The notification or the next Stop settles it.
    }
    return next(e)
  })
}

export async function runningSessionStart($: Api, e: Parameters<Hook<'session.start'>>[1], next: Parameters<Hook<'session.start'>>[2]): Promise<Awaited<ReturnType<Hook<'session.start'>>>> {
  try {
    if ((await read($, tasksAtom)).some(isRunning)) ensureTicker($ as Api)
  } catch {
    // The timer starts again with the next launch.
  }
  return next(e)
}

export async function runningToolCall($: Api, e: Parameters<Hook<'tool.call'>>[1], next: Parameters<Hook<'tool.call'>>[2]): Promise<Awaited<ReturnType<Hook<'tool.call'>>>> {
  const ran = await next(e)
  try {
    if (e.tool === 'TaskStop' && ran.deny === undefined && ran.isError !== true) {
      const stopped = safeId((ran.result as { task_id?: unknown } | undefined)?.task_id)
      if (stopped !== undefined) {
        const now = await $.clock.now()
        let ended: RunningTask[] = []
        await update($, tasksAtom, list =>
          list.map(task => {
            if (task.id !== stopped || task.status !== 'running') return task
            const done = end(task, 'killed', now)
            ended = [done]
            return done
          }),
        )
        announce($ as Api, ended)
      }
      return ran
    }
    if (ran.deny !== undefined || ran.isError === true) return ran
    if (e.tool !== 'Bash' && e.tool !== 'Monitor' && e.tool !== 'Agent' && e.tool !== 'Workflow') return ran
    const startedAt = await $.clock.now()
    const launch = launchOf(e.tool, e as unknown as Record<string, unknown>, ran.result, ran.text, startedAt)
    if (launch === undefined) return ran
    const agentLabel = await agentLabelOf($ as Api, e.agentId)
    const task: RunningTask = {
      ...launch,
      status: 'running',
      startedAt,
      toolUseId: e.tool_use_id,
      ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
      ...(agentLabel === undefined ? {} : { agentLabel }),
    }
    await update($, tasksAtom, list => addTask(list, task, startedAt))
    ensureTicker($ as Api)
  } catch {
    // Tracking is best effort; the call's result stands.
  }
  return ran
}
