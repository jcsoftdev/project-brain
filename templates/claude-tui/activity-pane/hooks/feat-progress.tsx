import type { Hook } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Api, Row, Span } from './register'
import { clean, fit, ICONS, span } from './register'

/** One task line of an ODD task doc. */
export type ProgressTask = { id: string; title: string; done: boolean; route?: string; commit?: string }

/** What the progress card draws, parsed from `odd/tasks/<feature>.md`. */
export type ProgressDoc = {
  feature: string
  path: string
  title: string
  objective?: string
  tasks: ProgressTask[]
  done: number
  total: number
  current?: ProgressTask
  pending: string[]
}

/** The stored card: the doc it came from (path + mtime, to skip re-parsing) and the parse, absent when nothing shows. */
export type ProgressState = { path: string; mtimeMs: number; doc?: ProgressDoc }

export type ProgressPart = { doc?: ProgressDoc }

const CAP_BYTES = 256 * 1024
const MAX_TASKS = 200
const MAX_PENDING = 5
const TEXT_MAX = 240
const BAR_CELLS = 10
const RUN_TIMEOUT_MS = 3000

const progressState = atom({ plugin: 'project-brain-activity', key: 'progress' } as const, { path: '', mtimeMs: 0 } as ProgressState, { shape: 'progress-1' })

// ---------------------------------------------------------------- parser

const TASK_HEADING = /^(#{2,3})\s+(?:tasks|tareas|checklist|work units|units|unidades)\b/i
const LOG_HEADING = /^(#{2,3})\s+(?:log|progress|progreso|registro|bit[aá]cora)\b/i
const OBJECTIVE_HEADING = /^#{2,3}\s+(?:objective|objetivo)\b/i
const OBJECTIVE_LINE = /^\**(?:objective|objetivo)\**\s*:\**\s*(.+)$/i
const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX~-])\]\s+(.*)$/
const BULLET_ID = /^(\s*)[-*+]\s+(.*)$/
const ID = /^\**([A-Z][A-Za-z]{0,3}-?\d+(?:\.\d+)?[a-z]?)\**(?=[\s:.)—–-]|$)/
const COMMIT = /(?:commit\s+`?|`)([0-9a-f]{7,40})\b/i
const ROUTE = /\b(?:route|ruta)\s*:?\s*\**\s*(inline|delegated|delegada|delegado)/i
const ROUTE_PAREN = /\((inline|delegated|delegada|delegado)\b/i
const DONE_STATUS = /^\W*(?:done|hecho|hecha|completed?|completad[oa]|ok|x)\b|^[✓✔✅]/i
const DROPPED_STATUS = /^\W*(?:dropped|descartad[oa]|cancel)/i
const DONE_WORD = /\b(?:done|hecho|hecha|completad[oa])\b|✅/gi
const NEGATED = /\b(?:not(?:\s+yet)?|no|pending|todo|sin|falta(?:n)?)\s+(?:\w+\s+)?$/i
const TRAILING_SHAS = /\s+((?:[0-9a-f]{7,12})(?:\s*,\s*[0-9a-f]{7,12})*)\s*[.;]?\s*$/i

/** A plain line counts as done when one of its done words carries no negation right before it. */
export const saysDone = (text: string): boolean =>
  [...text.matchAll(DONE_WORD)].some(match => !NEGATED.test(text.slice(0, match.index)))

/** The SHAs a done line ends with, such as `T1 (S1-S3) c64a223, 78e3bfd.` */
const trailingShas = (text: string): { shas: string[]; at: number } | undefined => {
  const match = TRAILING_SHAS.exec(text)
  if (!match) return undefined
  const shas = (match[1] ?? '').split(/\s*,\s*/).filter(one => /\d/.test(one))
  return shas.length > 0 ? { shas, at: match.index } : undefined
}

/** Skipped, pending or not-run checks, Spanish and English. */
const PENDING = new RegExp(
  [
    String.raw`\bno\s+(?:se\s+)?(?:corri[oó]|corrieron|(?:ejecut|verific|prob)(?:ad[oa]s?|[oó]|aron)\b)`,
    String.raw`\bsin\s+(?:probar|verificar|correr|ejecutar)`,
    String.raw`\bpendiente`,
    String.raw`\bomitid[oa]s?\b`,
    String.raw`\bfalta(?:n)?\s+(?:probar|verificar|correr)`,
    String.raw`\bnot\s+(?:yet\s+)?(?:run|ran|executed|verified|tested|checked)\b`,
    String.raw`\bdid(?:\s+not|n['’]t)\s+run\b`,
    String.raw`\b(?:untested|unverified)\b`,
    String.raw`\b(?:tests?|checks?|specs?|e2e|suites?|verifications?|smoke)\s+(?:were\s+|was\s+)?skipped\b`,
    String.raw`\bskipped\s+(?:the\s+)?(?:tests?|checks?|specs?|e2e|suites?|verification|smoke)\b`,
    String.raw`\bpending\b(?!-)`,
  ].join('|'),
  'i',
)
const NOT_PENDING = /\b(?:nothing|nada|ningun[oa]?|no|0)\s+(?:\w+\s+)?(?:pending|pendientes?)\b/i

const oneLine = (raw: string): string => clean(raw).replace(/\s+/g, ' ').trim()
const clip = (raw: string): string => {
  const line = oneLine(raw)
  return line.length <= TEXT_MAX ? line : `${line.slice(0, TEXT_MAX - 1)}…`
}
const unbold = (raw: string): string => raw.replace(/\*\*/g, '')

type Section = { lines: string[] }

/** The lines under the first heading matching `heading`, up to the next heading of the same or higher level. */
const sectionOf = (lines: string[], heading: RegExp, last = false): Section | undefined => {
  let found: Section | undefined
  for (let index = 0; index < lines.length; index++) {
    const match = heading.exec(lines[index] ?? '')
    if (!match) continue
    const level = (match[1] ?? '##').length
    const body: string[] = []
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next] ?? ''
      const head = /^(#{1,6})\s/.exec(line)
      if (head && (head[1] ?? '').length <= level) break
      body.push(line)
    }
    found = { lines: body }
    if (!last) return found
  }
  return found
}

const taskFrom = (body: string, index: number, done: boolean): ProgressTask => {
  const text = unbold(body).trim()
  const idMatch = ID.exec(text)
  const id = idMatch?.[1] ?? `#${index + 1}`
  const tagged = COMMIT.exec(text)?.[1]
  const bare = done && tagged === undefined ? trailingShas(text) : undefined
  const described = bare === undefined ? text : text.slice(0, bare.at)
  const rest = idMatch ? described.slice(idMatch[0].length) : described
  const title = clip(rest.replace(/^[\s:.)—–-]+/, '').replace(/\s*(?:[.;]\s*)?\b(?:route|ruta)\s*:.*$/i, '')) || id
  const route = ROUTE.exec(text)?.[1] ?? ROUTE_PAREN.exec(text)?.[1]
  const commit = tagged ?? bare?.shas[0]
  const task: ProgressTask = { id, title, done }
  if (route !== undefined) task.route = route.toLowerCase().startsWith('deleg') ? 'delegated' : 'inline'
  if (commit !== undefined && /\d/.test(commit)) task.commit = commit
  return task
}

const cellsOf = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(one => one.trim())

const tableTasks = (lines: string[]): ProgressTask[] | undefined => {
  const table = lines.filter(line => line.trim().startsWith('|'))
  if (table.length < 3) return undefined
  const header = cellsOf(table[0] ?? '').map(one => unbold(one).toLowerCase())
  const column = (names: RegExp): number => header.findIndex(one => names.test(one))
  const idAt = column(/^(?:id|#|task|tarea)$/)
  const statusAt = column(/^(?:status|estado)$/)
  if (statusAt < 0) return undefined
  const titleAt = column(/^(?:unit|unidad|title|t[ií]tulo|task|tarea|descripci[oó]n|description|what|qu[eé])$/)
  const routeAt = column(/^(?:route|ruta)$/)
  const commitAt = column(/^commit$/)
  const tasks: ProgressTask[] = []
  for (const line of table.slice(1)) {
    if (/^\|?\s*:?-{2,}/.test(line.trim())) continue
    const cells = cellsOf(line)
    const status = cells[statusAt] ?? ''
    if (DROPPED_STATUS.test(status)) continue
    const id = unbold(cells[idAt >= 0 ? idAt : 0] ?? '').trim() || `#${tasks.length + 1}`
    const fallbackAt = idAt >= 0 ? idAt + 1 : 1
    const titleCell = titleAt >= 0 && titleAt !== idAt ? titleAt : [statusAt, routeAt, commitAt].includes(fallbackAt) ? -1 : fallbackAt
    const title = (titleCell >= 0 ? clip(unbold(cells[titleCell] ?? '')) : '') || clip(id)
    const task: ProgressTask = { id: clip(id), title, done: DONE_STATUS.test(status) }
    const route = routeAt >= 0 ? cells[routeAt] ?? '' : ''
    if (/deleg/i.test(route)) task.route = 'delegated'
    else if (/inline/i.test(route)) task.route = 'inline'
    const commit = commitAt >= 0 ? /\b([0-9a-f]{7,40})\b/.exec(cells[commitAt] ?? '')?.[1] : undefined
    if (commit !== undefined && /\d/.test(commit)) task.commit = commit
    tasks.push(task)
  }
  return tasks.length > 0 ? tasks : undefined
}

const checkboxTasks = (lines: string[]): ProgressTask[] | undefined => {
  const boxes = lines.map(line => CHECKBOX.exec(line)).filter((one): one is RegExpExecArray => one !== null)
  if (boxes.length === 0) return undefined
  const indent = Math.min(...boxes.map(one => (one[1] ?? '').length))
  const tasks: ProgressTask[] = []
  for (const box of boxes) {
    if ((box[1] ?? '').length !== indent) continue
    const mark = box[2] ?? ' '
    if (mark === '-') continue
    tasks.push(taskFrom(box[3] ?? '', tasks.length, mark === 'x' || mark === 'X'))
  }
  return tasks
}

/** Plain `- T1 …` bullets with no checkbox: done only when the line says so. */
const bulletTasks = (lines: string[]): ProgressTask[] | undefined => {
  const tasks: ProgressTask[] = []
  for (const line of lines) {
    const bullet = BULLET_ID.exec(line)
    if (!bullet || (bullet[1] ?? '').length > 0) continue
    if (!ID.test(unbold(bullet[2] ?? ''))) continue
    tasks.push(taskFrom(bullet[2] ?? '', tasks.length, saysDone(bullet[2] ?? '')))
  }
  return tasks.length > 0 ? tasks : undefined
}

const objectiveOf = (lines: string[]): string | undefined => {
  for (const line of lines.slice(0, 12)) {
    const match = OBJECTIVE_LINE.exec(line.trim())
    if (match?.[1]) return clip(match[1])
  }
  const section = sectionOf(lines, OBJECTIVE_HEADING)
  const first = section?.lines.find(line => line.trim() !== '')
  return first === undefined ? undefined : clip(first)
}

const LOG_PREFIX = /^(?:[A-Z]\d+\s*)?\(?\d{4}-\d{2}-\d{2}\)?:?/
const EXCERPT_BEFORE = 40
const EXCERPT_AFTER = 110

/** A long log line as its L#/date prefix plus the words around the pending marker, so the red line says what did not run. */
export const excerptOf = (line: string): string => {
  const flat = oneLine(line)
  const match = PENDING.exec(flat)
  if (match === null || flat.length <= EXCERPT_BEFORE + EXCERPT_AFTER) return clip(flat)
  const prefix = LOG_PREFIX.exec(flat)?.[0] ?? ''
  const from = Math.max(prefix.length, match.index - EXCERPT_BEFORE)
  const space = flat.indexOf(' ', from)
  const start = from > prefix.length && space >= 0 && space < match.index ? space + 1 : from
  const end = Math.min(flat.length, match.index + EXCERPT_AFTER)
  const body = `${start > prefix.length ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
  return clip(prefix === '' ? body : `${prefix} ${body}`)
}

const pendingOf = (lines: string[]): string[] => {
  const section = sectionOf(lines, LOG_HEADING, true)
  if (!section) return []
  return section.lines
    .map(line => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim())
    .filter(line => line !== '' && PENDING.test(line) && !NOT_PENDING.test(line))
    .slice(-MAX_PENDING)
    .map(excerptOf)
}

/** Parses an ODD task doc; undefined when it has no tasks section or no tasks. */
export const parseTaskDoc = (text: string, path: string): ProgressDoc | undefined => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const section = sectionOf(lines, TASK_HEADING)
  if (!section) return undefined
  const tasks = (tableTasks(section.lines) ?? checkboxTasks(section.lines) ?? bulletTasks(section.lines) ?? []).slice(0, MAX_TASKS)
  if (tasks.length === 0) return undefined
  const feature = clip((path.split('/').pop() ?? path).replace(/\.md$/i, ''))
  const heading = lines.find(line => /^#\s/.test(line))
  const done = tasks.filter(one => one.done).length
  const doc: ProgressDoc = {
    feature,
    path: clip(path),
    title: heading === undefined ? feature : clip(heading.replace(/^#\s+/, '')),
    tasks,
    done,
    total: tasks.length,
    pending: pendingOf(lines),
  }
  const objective = objectiveOf(lines)
  if (objective !== undefined) doc.objective = objective
  const current = tasks.find(one => !one.done)
  if (current !== undefined) doc.current = current
  return doc
}

// ---------------------------------------------------------------- drawing

export const progressBar = (done: number, total: number, cells = BAR_CELLS): string => {
  const filled = total <= 0 ? 0 : Math.min(cells, Math.round((done / total) * cells))
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

export const rowsProgress = (
  part: ProgressPart,
  ctx: { width: number; accent: string; isOpen: (key: string, byDefault: boolean) => boolean },
): Row[] => {
  const doc = part.doc
  if (doc === undefined) return []
  const width = Math.max(10, ctx.width)
  const key = 'progress-card'
  const open = ctx.isOpen(key, true)
  const label = `Progreso · ${doc.feature} · ${doc.done}/${doc.total}`
  const rows: Row[] = [
    {
      key,
      cells: [{ spans: [span(fit(`${open ? '▼' : '▶'} ${label}`, width), { color: ctx.accent, bold: true })], action: { kind: 'toggle', key }, label, key: `btn-${key}` }],
    },
  ]
  if (!open) return rows
  const isComplete = doc.done === doc.total
  const percent = doc.total === 0 ? 0 : Math.round((doc.done / doc.total) * 100)
  rows.push({
    key: 'progress-bar',
    cells: [{ spans: [span('  '), span(progressBar(doc.done, doc.total), { color: isComplete ? 'success' : ctx.accent }), span(fit(`  ${percent}%`, Math.max(1, width - 2 - BAR_CELLS)), { dim: true })] }],
  })
  if (doc.current !== undefined) {
    const route = doc.current.route === undefined ? '' : ` · ${doc.current.route === 'delegated' ? 'delegada' : 'inline'}`
    rows.push({
      key: 'progress-current',
      cells: [{ spans: [span(`  ${ICONS.running} `, { color: 'warning' }), span(fit(`Ahora: ${doc.current.id} ${doc.current.title}${route}`, Math.max(1, width - 4)))] }],
    })
  } else {
    rows.push({ key: 'progress-current', cells: [{ spans: [span(`  ${ICONS.ok} `, { color: 'success' }), span(fit('Todas las tareas están hechas', Math.max(1, width - 4)), { color: 'success' })] }] })
  }
  if (doc.pending.length > 0) {
    rows.push({ key: 'progress-pending-head', cells: [{ spans: [span(fit(`  Verificaciones sin correr (${doc.pending.length})`, width), { color: 'error', bold: true })] }] })
    doc.pending.forEach((line, index) => {
      rows.push({ key: `progress-pending-${index}`, cells: [{ spans: [span(`  ${ICONS.error} `, { color: 'error' }), span(fit(line, Math.max(1, width - 4)), { color: 'error' })] }] })
    })
  }
  return rows
}

export const footerProgress = (part: ProgressPart): Span[] => {
  const doc = part.doc
  if (doc === undefined) return []
  return [span(`T ${doc.done}/${doc.total}`, { color: doc.done === doc.total ? 'success' : doc.pending.length > 0 ? 'error' : 'subtle' })]
}

// ---------------------------------------------------------------- loading

type RunText = (argv: readonly string[], cwd: string) => Promise<string | undefined>

/** The `odd/tasks` folders to look in: the session's checkout, and the main checkout when it runs inside a worktree. */
export const taskDirsOf = async (run: RunText, cwd: string): Promise<string[]> => {
  const top = (await run(['git', 'rev-parse', '--show-toplevel'], cwd))?.trim()
  const common = (await run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd))?.trim()
  const main = common !== undefined && /\/\.git\/?$/.test(common) ? common.replace(/\/\.git\/?$/, '') : undefined
  const roots = [top || cwd, main].filter((one): one is string => one !== undefined && one !== '')
  return [...new Set(roots)].map(root => `${root.replace(/\/$/, '')}/odd/tasks`)
}

export const isTaskDocPath = (path: string): boolean => /(?:^|\/)odd\/tasks\/[^/]+\.md$/i.test(path)

let loading = false
let loadAgain = false

async function loadProgress($: Api): Promise<void> {
  const run: RunText = async (argv, cwd) => {
    const result = await $.process.run(argv, { cwd, timeoutMs: RUN_TIMEOUT_MS }).catch(() => undefined)
    return result?.exitCode === 0 ? result.stdout : undefined
  }
  const cwd = (await $.session.cwd().catch(() => undefined)) ?? (await $.session.root().catch(() => undefined))
  if (cwd === undefined) return
  const dirs = await taskDirsOf(run, cwd)
  let newest: { path: string; mtimeMs: number } | undefined
  for (const dir of dirs) {
    const found = await $.fs.list(dir).catch(() => [])
    for (const entry of found) {
      if (entry.kind !== 'file' || !/\.md$/i.test(entry.name)) continue
      if (newest === undefined || entry.mtimeMs > newest.mtimeMs) newest = { path: `${dir}/${entry.name}`, mtimeMs: entry.mtimeMs }
    }
  }
  if (newest === undefined) {
    await update($, progressState, () => ({ path: '', mtimeMs: 0 }))
    return
  }
  const stat = await $.fs.stat(newest.path).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file') return
  const stored = await read($, progressState)
  if (stored.path === newest.path && stored.mtimeMs === stat.mtimeMs) return
  const chosen = newest.path
  if (stat.size > CAP_BYTES) {
    await update($, progressState, () => ({ path: chosen, mtimeMs: stat.mtimeMs }))
    return
  }
  const text = await $.fs.read(chosen).catch(() => undefined)
  if (text === undefined) return
  const doc = parseTaskDoc(text, chosen)
  await update($, progressState, () => (doc === undefined ? { path: chosen, mtimeMs: stat.mtimeMs } : { path: chosen, mtimeMs: stat.mtimeMs, doc }))
}

async function refreshProgress($: Api): Promise<void> {
  if (loading) {
    loadAgain = true
    return
  }
  loading = true
  try {
    do {
      loadAgain = false
      await loadProgress($).catch(() => undefined)
    } while (loadAgain)
  } finally {
    loading = false
  }
}

export async function readProgress($: Api): Promise<ProgressPart> {
  const stored = await read($, progressState).catch(() => undefined)
  return stored?.doc === undefined ? {} : { doc: stored.doc }
}

export const registerProgress = (on: Parameters<Register>[0]): void => {


}

export async function progressSessionStart($: Api, e: Parameters<Hook<'session.start'>>[1], next: Parameters<Hook<'session.start'>>[2]): Promise<Awaited<ReturnType<Hook<'session.start'>>>> {
  const result = await next(e)
  void refreshProgress($ as Api).catch(() => undefined)
  return result
}

export async function progressTurnComplete($: Api, e: Parameters<Hook<'turn.complete'>>[1], next: Parameters<Hook<'turn.complete'>>[2]): Promise<Awaited<ReturnType<Hook<'turn.complete'>>>> {
  const result = await next(e)
  void refreshProgress($ as Api).catch(() => undefined)
  return result
}

export async function progressToolCall($: Api, e: Parameters<Hook<'tool.call'>>[1], next: Parameters<Hook<'tool.call'>>[2]): Promise<Awaited<ReturnType<Hook<'tool.call'>>>> {
  const result = await next(e)
  try {
    if (e.tool === 'Write' || e.tool === 'Edit') {
      const path = (e as unknown as { file_path?: unknown }).file_path
      if (typeof path === 'string' && isTaskDocPath(path)) void refreshProgress($ as Api).catch(() => undefined)
    }
  } catch {
    // A failed refresh only leaves the card as it was.
  }
  return result
}
