import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRecord, AgentState, CallStatus, Decision, FileChange, PaneScroll, Tab, TestFile, ToolEntry } from '../types'

const PANE = 'activity'
const MAIN = 'main'
const WIDEST = 1000
const KEEP = 300
const OUTPUT_LINES = 40
const DIFF_LINES = 120
const TEST_FILES = 30
const SUMMARY_FIELDS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'] as const
const CHANGE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS'])
const VALIDATION = /\b(test|tests|vitest|jest|pytest|tsc|typecheck|lint|eslint|biome)\b/

export const ICONS = {
  summary: '\u{F0756}',
  commands: '\u{E795}',
  diff: '\u{E727}',
  ok: '\u{F00C}',
  error: '\u{F00D}',
  running: '\u{F192}',
  denied: '\u{F05E}',
  waiting: '\u{F252}',
  agent: '\u{F06A9}',
  cost: '\u{F155}',
  question: '\u{F059}',
  read: '\u{F06E}',
  edit: '\u{F040}',
  validate: '\u{F0668}',
  command: '\u{F489}',
  other: '\u{F0EB}',
  history: '\u{F1DA}',
  folder: '\u{F07C}',
  file: '\u{F016}',
  ts: '\u{F06E6}',
  tsx: '\u{E7BA}',
  json: '\u{F0626}',
  md: '\u{F0354}',
  sh: '\u{E691}',
} as const

const FILE_ICONS: Record<string, string> = {
  ts: ICONS.ts,
  mts: ICONS.ts,
  cts: ICONS.ts,
  tsx: ICONS.tsx,
  jsx: ICONS.tsx,
  json: ICONS.json,
  md: ICONS.md,
  sh: ICONS.sh,
  zsh: ICONS.sh,
  bash: ICONS.sh,
}

const entries = atom({ plugin: 'project-brain-activity', key: 'entries' } as const, [] as ToolEntry[], { shape: 'entries-3' })
const tabs = atom({ plugin: 'project-brain-activity', key: 'tabs' } as const, {} as Record<string, Tab>, { shape: 'tabs-1' })
const toggled = atom({ plugin: 'project-brain-activity', key: 'toggled' } as const, [] as string[], { shape: 'toggled-2' })
const changes = atom({ plugin: 'project-brain-activity', key: 'changes' } as const, [] as FileChange[], { shape: 'changes-1' })
const openFiles = atom({ plugin: 'project-brain-activity', key: 'openFiles' } as const, [] as string[], { shape: 'open-files-1' })
const diffs = atom({ plugin: 'project-brain-activity', key: 'diffs' } as const, {} as Record<string, string>, { shape: 'diffs-1' })
const costUsd = atom({ plugin: 'project-brain-activity', key: 'costUsd' } as const, 0, { shape: 'cost-1' })
const contextPercent = atom({ plugin: 'project-brain-activity', key: 'contextPercent' } as const, 0, { shape: 'context-1' })
const agents = atom({ plugin: 'project-brain-activity', key: 'agents' } as const, [] as AgentRecord[], { shape: 'agents-1' })
const pickedAgent = atom({ plugin: 'project-brain-activity', key: 'pickedAgent' } as const, '', { shape: 'picked-1' })
const working = atom({ plugin: 'project-brain-activity', key: 'working' } as const, false, { shape: 'working-1' })
const scroll = atom({ plugin: 'project-brain-activity', key: 'scroll' } as const, { offset: 0, follow: false } as PaneScroll, { shape: 'scroll-1' })

let layout = { total: 0, room: 1 }

// One nvim per session, reused on every Enter: it listens on a socket, and
// later opens are sent to it instead of starting another editor.
const OPEN_IN_NVIM = [
  "file=\"$1\"",
  "sock=\"${TMPDIR:-/tmp}/project-brain-activity-nvim.sock\"",
  "diff_cmd='lua vim.defer_fn(function() pcall(vim.cmd, \"Gitsigns diffthis HEAD\") end, 200)'",
  "if [ -S \"$sock\" ] && nvim --server \"$sock\" --remote-expr 1 >/dev/null 2>&1; then",
  "  nvim --server \"$sock\" --remote-send \"<C-\\\\><C-n>:silent! diffoff! | only | edit $(printf %s \"$file\" | sed 's/ /\\\\ /g')<CR>:$diff_cmd<CR>\"",
  "  if command -v supacode >/dev/null 2>&1 && [ -f \"$sock.tab\" ]; then supacode tab focus -t \"$(cat \"$sock.tab\")\" >/dev/null 2>&1; fi",
  "  exit 0",
  "fi",
  "rm -f \"$sock\" \"$sock.tab\"",
  "q=$(printf %s \"$file\" | sed \"s/'/'\\\\\\\\''/g\")",
  "start=\"nvim --listen '$sock' '$q' '+$diff_cmd'\"",
  "if [ -n \"$SUPACODE_SOCKET_PATH\" ] && command -v supacode >/dev/null 2>&1; then",
  "  tab=$(supacode pane split -d h -i \"$start\") && printf %s \"$tab\" > \"$sock.tab\" && exit 0",
  "fi",
  "if [ -n \"$TMUX\" ]; then tmux split-window -h -c \"$PWD\" \"$start\" && exit 0; fi",
  "osascript -e \"tell application \\\"Terminal\\\" to do script \\\"cd '$PWD' && $start\\\"\" >/dev/null",
].join('\n')

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-_]/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g
export const clean = (text: string): string => text.replace(ANSI, '').replace(/\t/g, '  ').replace(CONTROL, '')

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

const oneLine = (raw: string): string => clean(raw).replace(/\s+/g, ' ').trim()

const summarize = (input: Record<string, unknown>): string => {
  const field = SUMMARY_FIELDS.find(name => text(input[name]) !== undefined)
  return oneLine(field ? String(input[field]) : JSON.stringify(input)).slice(0, 200)
}

const lastLines = (raw: string | undefined, count: number): string =>
  clean(raw ?? '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line !== '')
    .slice(-count)
    .map(line => line.slice(0, 300))
    .join('\n')

export const dollars = (usd: number): string => `~$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

export const seconds = (ms: number | undefined): string => (ms === undefined ? '' : `${(ms / 1000).toFixed(1)} s`)

export const fit = (value: string, width: number): string => {
  const room = Math.max(1, width)
  return value.length <= room ? value : `${value.slice(0, Math.max(0, room - 1))}…`
}

const baseName = (path: string): string => path.split('/').pop() ?? path

const stem = (path: string): string => baseName(path).replace(/\.[^.]+$/, '')

const joinY = (parts: string[]): string =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}`

const distinct = (values: (string | undefined)[]): string[] => [...new Set(values.filter((one): one is string => one !== undefined))]

export const fileIcon = (path: string): string => FILE_ICONS[baseName(path).split('.').pop()?.toLowerCase() ?? ''] ?? ICONS.file

export const exitCodeOf = (output: string | undefined, isError: boolean): number => {
  const stated = /exit code:?\s*(\d+)/i.exec(output ?? '')?.[1]
  return stated !== undefined ? Number(stated) : isError ? 1 : 0
}

export type TestCounts = { passed?: number; failed?: number; pending?: number }

const countOf = (output: string, pattern: RegExp): number | undefined => {
  const found = pattern.exec(output)?.[1]
  return found === undefined ? undefined : Number(found)
}

export const testCounts = (output: string): TestCounts => ({
  passed: countOf(output, /(\d+)\s+(?:pass(?:ed)?|passing)\b/i),
  failed: countOf(output, /(\d+)\s+(?:fail(?:ed)?|failing)\b/i),
  pending: countOf(output, /(\d+)\s+(?:skip(?:ped)?|todo|pending)\b/i),
})

const TEST_PATH = String.raw`[\w./@-]+\.(?:test|spec)\.[cm]?[jt]sx?`
const JEST_LINE = new RegExp(String.raw`^\s*(PASS|FAIL)\s+(${TEST_PATH})`)
const VITEST_LINE = new RegExp(String.raw`^\s*([✓✔]|[×✗❯])\s+(${TEST_PATH})`)
const BUN_HEADER = new RegExp(String.raw`^(${TEST_PATH}):\s*$`)

export const testFilesOf = (output: string): TestFile[] => {
  const found = new Map<string, boolean>()
  let bunFile: string | undefined
  for (const line of clean(output).split('\n')) {
    const jest = JEST_LINE.exec(line)
    if (jest?.[2]) { found.set(jest[2], jest[1] === 'PASS'); continue }
    const vitest = VITEST_LINE.exec(line)
    if (vitest?.[2]) { found.set(vitest[2], /[✓✔]/.test(vitest[1] ?? '')); continue }
    const header = BUN_HEADER.exec(line.trim())
    if (header?.[1]) { bunFile = header[1]; found.set(bunFile, found.get(bunFile) ?? true); continue }
    if (bunFile !== undefined && /^\s*(?:\(fail\)|✗)/.test(line)) found.set(bunFile, false)
  }
  return [...found].slice(0, TEST_FILES).map(([file, ok]) => ({ file, ok }))
}

export const verdictOf = (entry: ToolEntry): 'PASS' | 'FAIL' | undefined => {
  if (entry.status === 'running' || entry.command === undefined) return undefined
  const counts = testCounts(entry.output)
  if (counts.failed !== undefined && counts.failed > 0) return 'FAIL'
  if (counts.passed !== undefined) return entry.exitCode === 0 ? 'PASS' : 'FAIL'
  if (VALIDATION.test(entry.command)) return entry.exitCode === 0 ? 'PASS' : 'FAIL'
  return undefined
}

export const resultLine = (entry: ToolEntry): string => {
  const counts = testCounts(entry.output)
  const parts: string[] = []
  if (counts.passed !== undefined) parts.push(`${counts.passed} pruebas`)
  if (counts.failed !== undefined && counts.failed > 0) parts.push(`${counts.failed} fallaron`)
  if (counts.pending !== undefined && counts.pending > 0) parts.push(`${counts.pending} ${counts.pending === 1 ? 'pendiente' : 'pendientes'}`)
  if (entry.exitCode !== undefined) parts.push(`exit ${entry.exitCode}`)
  return parts.join(' · ')
}

export const parseNumstat = (stdout: string): FileChange[] =>
  stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter(parts => parts.length === 3)
    .map(([added, removed, path]) => ({ path: path ?? '', added: Number(added) || 0, removed: Number(removed) || 0 }))

export type DiffRow = { gutter: string; sign: string; text: string; kind: 'add' | 'del' | 'hunk' | 'same' }

export const diffRows = (patch: string): DiffRow[] => {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  for (const raw of clean(patch).split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      rows.push({ gutter: '', sign: '@@', text: `línea ${newLine}${hunk[3] ?? ''}`, kind: 'hunk' })
      continue
    }
    if (rows.length === 0 || raw.startsWith('\\')) continue
    const sign = raw.charAt(0)
    const body = raw.slice(1)
    if (sign === '+') rows.push({ gutter: String(newLine++), sign: '+', text: body, kind: 'add' })
    else if (sign === '-') rows.push({ gutter: String(oldLine++), sign: '-', text: body, kind: 'del' })
    else if (sign === ' ') { rows.push({ gutter: String(newLine), sign: ' ', text: body, kind: 'same' }); oldLine++; newLine++ }
  }
  return rows
}

export type StepKind = 'read' | 'edit' | 'validate' | 'command' | 'agent' | 'question' | 'other'

export type Step = {
  key: string
  kind: StepKind
  title: string
  detail: string
  status: CallStatus
  durationMs?: number
}

export const stepKindOf = (entry: ToolEntry): StepKind => {
  if (READ_TOOLS.has(entry.tool)) return 'read'
  if (CHANGE_TOOLS.has(entry.tool)) return 'edit'
  if (entry.tool === 'Bash') return VALIDATION.test(entry.command ?? '') ? 'validate' : 'command'
  if (entry.tool === 'Agent' || entry.tool === 'Task') return 'agent'
  if (entry.tool === 'AskUserQuestion') return 'question'
  return 'other'
}

const SOLO_KINDS = new Set<StepKind>(['agent', 'question', 'other'])

const groupStatus = (group: ToolEntry[]): CallStatus => {
  if (group.some(one => one.status === 'running')) return 'running'
  if (group.some(one => one.status === 'error')) return 'error'
  if (group.some(one => one.status === 'denied')) return 'denied'
  return 'ok'
}

const groupDuration = (group: ToolEntry[]): number | undefined => {
  if (group.some(one => one.durationMs === undefined)) return undefined
  const start = Math.min(...group.map(one => one.startedAt))
  const end = Math.max(...group.map(one => one.startedAt + (one.durationMs ?? 0)))
  return end - start
}

const filesLine = (files: string[], verb: string): string =>
  files.length > 3 ? `${files.length} archivos ${verb}` : files.map(baseName).join(' · ')

const describeRead = (group: ToolEntry[], running: boolean) => {
  const files = distinct(group.filter(one => one.tool === 'Read').map(one => one.file))
  const searches = group.filter(one => one.tool !== 'Read')
  const topic = files.length === 0 ? 'el código' : files.length > 2 ? `${files.length} archivos` : joinY(files.map(stem))
  const parts = [files.length > 0 ? filesLine(files, 'consultados') : '', searches.length > 0 ? `${searches.length} ${searches.length === 1 ? 'búsqueda' : 'búsquedas'}` : '']
  return { title: `${running ? 'Revisando' : 'Revisó'} ${topic}`, detail: parts.filter(Boolean).join(' · ') }
}

const describeEdit = (group: ToolEntry[], running: boolean) => {
  const files = distinct(group.map(one => one.file))
  const title =
    files.length === 1
      ? `${running ? 'Actualizando' : 'Actualizó'} ${stem(files[0] ?? '')}`
      : files.length > 1
        ? `${running ? 'Actualizando' : 'Actualizó'} ${files.length} archivos`
        : running ? 'Aplicando cambios' : 'Aplicó cambios'
  return { title, detail: filesLine(files, 'modificados') }
}

const describeValidate = (group: ToolEntry[], running: boolean) => {
  const commands = group.map(one => one.command ?? '')
  const hasTests = commands.some(command => /\b(test|tests|vitest|jest|pytest)\b/.test(command))
  const passed = group.reduce((sum, one) => sum + (testCounts(one.output).passed ?? 0), 0)
  const parts = distinct([
    commands.some(command => /\b(tsc|typecheck)\b/.test(command)) ? 'tipos' : undefined,
    commands.some(command => /\b(lint|eslint|biome)\b/.test(command)) ? 'lint' : undefined,
    hasTests ? (passed > 0 ? `${passed} pruebas` : 'pruebas') : undefined,
  ])
  const title = running ? (hasTests ? 'Ejecutando pruebas' : 'Ejecutando validaciones') : 'Ejecutó validaciones'
  return { title, detail: parts.join(' · ') }
}

const describeCommand = (group: ToolEntry[], running: boolean) => {
  const commands = group.map(one => oneLine(one.command ?? ''))
  const detail = commands.length === 1 ? (commands[0] ?? '') : `${commands.length} comandos: ${distinct(commands.map(command => command.split(' ')[0])).join(' · ')}`
  return { title: running ? 'Ejecutando comandos' : 'Ejecutó comandos', detail }
}

const describeStep = (kind: StepKind, group: ToolEntry[], running: boolean): { title: string; detail: string } => {
  const first = group[0]
  if (kind === 'read') return describeRead(group, running)
  if (kind === 'edit') return describeEdit(group, running)
  if (kind === 'validate') return describeValidate(group, running)
  if (kind === 'command') return describeCommand(group, running)
  if (kind === 'agent') return { title: `${running ? 'Delegando' : 'Delegó'}: ${first?.summary ?? ''}`, detail: first?.note ?? 'subagente' }
  if (kind === 'question') {
    const asked = first?.decisions ?? []
    return { title: running ? 'Esperando tu respuesta' : 'Preguntó al usuario', detail: asked.map(one => one.question).join(' · ') }
  }
  return { title: titleOf(first?.tool ?? ''), detail: first?.summary ?? '' }
}

export const groupSteps = (list: ToolEntry[]): Step[] => {
  const groups: { kind: StepKind; items: ToolEntry[] }[] = []
  for (const entry of list) {
    const kind = stepKindOf(entry)
    const last = groups.at(-1)
    if (last && last.kind === kind && !SOLO_KINDS.has(kind)) last.items.push(entry)
    else groups.push({ kind, items: [entry] })
  }
  return groups.map(({ kind, items }) => {
    const status = groupStatus(items)
    return { key: items[0]?.id ?? kind, kind, status, durationMs: groupDuration(items), ...describeStep(kind, items, status === 'running') }
  })
}

export const shortName = (record: Pick<AgentRecord, 'description' | 'name'>): string => {
  if (record.name) return fit(record.name, 16)
  const words = record.description.replace(/^\s*[\w-]+:\s*/, '').split(/\s+/).filter(Boolean)
  const pair = words.slice(0, 2).join(' ')
  const short = pair.length <= 16 && (words[1] ?? '').length > 3 ? pair : (words[0] ?? '')
  const named = short === '' ? 'Agente' : short.charAt(0).toUpperCase() + short.slice(1)
  return fit(named, 16)
}

export const defaultAgent = (records: AgentRecord[], picked: string): string => {
  if (picked !== '' && (picked === MAIN || records.some(one => one.id === picked))) return picked
  const running = records.filter(one => one.state === 'running').sort((a, b) => b.startedAt - a.startedAt)
  return running[0]?.id ?? MAIN
}

export const scrolled = (state: PaneScroll, by: number, total: number, room: number): PaneScroll => {
  const maxOffset = Math.max(0, total - room)
  const from = state.follow ? maxOffset : Math.min(state.offset, maxOffset)
  const step = Math.abs(by) >= room ? Math.sign(by) * Math.max(1, room - 1) : by
  const offset = Math.min(maxOffset, Math.max(0, from + step))
  return { offset, follow: maxOffset > 0 && offset === maxOffset }
}

export const windowStart = (state: PaneScroll, total: number, room: number): number => {
  const maxOffset = Math.max(0, total - room)
  return state.follow ? maxOffset : Math.min(state.offset, maxOffset)
}

const TITLES: Record<string, string> = {
  Bash: 'Ejecución de comando',
  Read: 'Lectura de archivo',
  Edit: 'Edición de archivo',
  Write: 'Escritura de archivo',
  Grep: 'Búsqueda en código',
  Glob: 'Búsqueda de archivos',
  Agent: 'Subagente',
  WebFetch: 'Consulta web',
  WebSearch: 'Búsqueda web',
  Skill: 'Skill',
}

const titleOf = (tool: string): string => TITLES[tool] ?? (tool.startsWith('mcp__') ? `MCP · ${tool.split('__').pop()}` : tool)

type Look = { icon: string; color: 'warning' | 'success' | 'error' | 'subtle' }

const STATUS_LOOK: Record<CallStatus, Look> = {
  running: { icon: ICONS.running, color: 'warning' },
  ok: { icon: ICONS.ok, color: 'success' },
  error: { icon: ICONS.error, color: 'error' },
  denied: { icon: ICONS.denied, color: 'subtle' },
}

const AGENT_LOOK: Record<AgentState, Look & { label: string }> = {
  running: { icon: ICONS.running, color: 'warning', label: 'ejecutando' },
  done: { icon: ICONS.ok, color: 'success', label: 'terminó' },
  failed: { icon: ICONS.error, color: 'error', label: 'falló' },
}

const KIND_ICONS: Record<StepKind, string> = {
  read: ICONS.read,
  edit: ICONS.edit,
  validate: ICONS.validate,
  command: ICONS.command,
  agent: ICONS.agent,
  question: ICONS.question,
  other: ICONS.other,
}

const TAB_LABELS: { value: Tab; icon: string; label: string }[] = [
  { value: 'summary', icon: ICONS.summary, label: 'Resumen' },
  { value: 'commands', icon: ICONS.commands, label: 'Comandos' },
  { value: 'diff', icon: ICONS.diff, label: 'Diff' },
]

const agentStateOf = (status: string): AgentState =>
  status === 'completed' || status === 'idle' ? 'done' : status === 'failed' || status === 'killed' ? 'failed' : 'running'

const decisionsOf = (input: Record<string, unknown>): Decision[] =>
  (Array.isArray(input.questions) ? input.questions : [])
    .map(one => text((one as { question?: unknown }).question))
    .filter((question): question is string => question !== undefined)
    .map(question => ({ question: oneLine(question), answer: '' }))

const answered = (decisions: Decision[], result: unknown): Decision[] => {
  const answers = ((result as { answers?: unknown } | undefined)?.answers ?? {}) as Record<string, unknown>
  return decisions.map(one => ({ ...one, answer: oneLine(String(answers[one.question] ?? '')) }))
}

const touches = (change: FileChange, edited: string[]): boolean =>
  edited.some(path => path === change.path || path.endsWith(`/${change.path}`))

export const mergeAgent = (list: AgentRecord[], record: AgentRecord): AgentRecord[] => {
  const known = list.find(one => one.id === record.id)
  const merged = known ? { ...known, ...record, startedAt: known.startedAt, description: record.description || known.description } : record
  return [...list.filter(one => one.id !== record.id), merged].slice(-30)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'activity', description: 'Abre el panel de actividad' })
    void $.ui.open({ id: PANE, title: 'Actividad', columns: WIDEST })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.cost !== undefined) await update($, costUsd, () => e.cost?.usd ?? 0)
    if (e.context.percent !== undefined) await update($, contextPercent, () => e.context.percent ?? 0)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, working, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await update($, working, () => false)
    else {
      const state: AgentState = e.isAborted ? 'failed' : 'done'
      await update($, agents, list => list.map(one => (one.id === e.agentId ? { ...one, state } : one)))
    }
    return done
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId !== undefined) {
      const record: AgentRecord = { id: spawned.agentId, description: e.description, type: e.subagentType, state: 'running', startedAt: await $.clock.now() }
      await update($, agents, list => mergeAgent(list, record))
      await update($, pickedAgent, () => '')
    }
    return spawned
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const usd = await read($, costUsd)
    if (usd <= 0) return next(e)
    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix} · ${dollars(usd)}` } })
  })

  on('command.run', { command: 'activity' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Actividad', columns: WIDEST })
    return { text: 'Panel de actividad abierto.' }
  })

  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    await update($, scroll, state => scrolled(state, e.by, layout.total, layout.room))
    return {}
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const startedAt = await $.clock.now()
    const entry: ToolEntry = {
      id: e.tool_use_id,
      tool: e.tool,
      summary: summarize(input),
      status: 'running',
      output: '',
      startedAt,
      agentId: e.agentId,
      command: e.tool === 'Bash' ? text(input.command) : undefined,
      file: text(input.file_path) ?? text(input.notebook_path),
      note: e.tool === 'Agent' ? text(input.subagent_type) : undefined,
      decisions: e.tool === 'AskUserQuestion' ? decisionsOf(input) : undefined,
    }
    await update($, entries, list => [...list, entry].slice(-KEEP))

    const loopId = e.agentId
    if (loopId !== undefined && !(await read($, agents)).some(one => one.id === loopId)) {
      const info = (await $.agent.list()).find(one => one.id === loopId)
      const record: AgentRecord = {
        id: loopId,
        description: info?.description ?? `Agente ${loopId.slice(0, 4)}`,
        type: info?.type ?? 'agente',
        name: info?.name,
        state: info ? agentStateOf(info.status) : 'running',
        startedAt,
      }
      await update($, agents, list => mergeAgent(list, record))
    }

    const ran = await next(e)
    const durationMs = (await $.clock.now()) - startedAt
    const status: CallStatus = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'ok'
    const full = ran.deny ?? ran.text ?? ''
    const finished: Partial<ToolEntry> = {
      status,
      durationMs,
      output: lastLines(full, OUTPUT_LINES),
      exitCode: entry.command !== undefined ? exitCodeOf(full, status !== 'ok') : undefined,
      testFiles: entry.command !== undefined ? testFilesOf(full) : undefined,
      decisions: entry.decisions ? answered(entry.decisions, ran.result) : undefined,
    }
    const spawnedId = text((ran.result as { agentId?: unknown } | undefined)?.agentId)
    if (e.tool === 'Agent' && spawnedId !== undefined) {
      finished.spawned = spawnedId
      await update($, agents, list => mergeAgent(list, { id: spawnedId, description: text(input.description) ?? '', type: entry.note ?? 'agente', state: status === 'ok' ? 'done' : 'failed', startedAt }))
    }
    await update($, entries, list => list.map(one => (one.id === entry.id ? { ...one, ...finished } : one)))

    if (e.tool === 'Bash' || CHANGE_TOOLS.has(e.tool)) {
      const diff = await $.process.run(['git', 'diff', '--numstat', 'HEAD']).catch(() => undefined)
      if (diff?.exitCode === 0) await update($, changes, () => parseNumstat(diff.stdout))
    }
    return ran
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.isExpanded === true) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (!e.props.isErrored) return <Box />
    const summary = summarize((e.props.input ?? {}) as Record<string, unknown>)
    return (
      <Text color="error" wrap="truncate-end">
        ✗ {e.props.tool} falló: {summary}
      </Text>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.isExpanded === true) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.origin.kind !== 'composer') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color="permission" bold>▎ Tú</Text>
        {await next(e)}
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!e.props.isFirstOfReply) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color="claude" bold>▎ Claude</Text>
        {await next(e)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [list, tabByAgent, flipped, files, usd, percent, opened, patches, records, picked, isWorking, view] = await Promise.all([
      read($, entries), read($, tabs), read($, toggled), read($, changes), read($, costUsd), read($, contextPercent),
      read($, openFiles), read($, diffs), read($, agents), read($, pickedAgent), read($, working), read($, scroll),
    ])
    const width = Math.max(20, e.props.bodyColumns)
    const scope = defaultAgent(records, picked)
    const current: Tab = tabByAgent[scope] ?? 'summary'
    const agent = records.find(one => one.id === scope)
    const scoped = list.filter(one => (one.agentId ?? MAIN) === scope)
    const commands = scoped.filter(one => one.command !== undefined)
    const lastCommand = commands.at(-1)
    const edited = distinct(scoped.filter(one => CHANGE_TOOLS.has(one.tool)).map(one => one.file))
    const scopedFiles = scope === MAIN ? files : files.filter(change => touches(change, edited))
    const waiting = list.some(one => one.tool === 'AskUserQuestion' && one.status === 'running')

    const isOpen = (key: string, byDefault: boolean): boolean => byDefault !== flipped.includes(key)
    const flip = (key: string) => () => void update($, toggled, keys => (keys.includes(key) ? keys.filter(one => one !== key) : [...keys, key].slice(-200)))
    const resetScroll = () => update($, scroll, () => ({ offset: 0, follow: false }))
    const pickTab = (value: Tab) => async () => {
      await update($, tabs, all => ({ ...all, [scope]: value }))
      await resetScroll()
    }
    const pickAgent = (id: string) => async () => {
      await update($, pickedAgent, () => id)
      await resetScroll()
    }
    const openInEditor = (path: string) => async () => {
      await $.process.run(['sh', '-c', OPEN_IN_NVIM, 'open-in-nvim', path]).catch(() => undefined)
    }
    const toggleFile = (path: string) => async () => {
      const isOpenNow = opened.includes(path)
      if (!isOpenNow) {
        const diff = await $.process.run(['git', 'diff', '--no-color', '--no-ext-diff', 'HEAD', '--', path]).catch(() => undefined)
        await update($, diffs, all => ({ ...all, [path]: diff?.exitCode === 0 ? diff.stdout : '' }))
      }
      await update($, openFiles, paths => (isOpenNow ? paths.filter(one => one !== path) : [...paths, path]))
    }

    const line = (key: string, value: string, props: Record<string, unknown> = {}): JSX.Element => (
      <Text key={key} wrap="truncate-end" {...props}>{fit(value, width)}</Text>
    )
    const split = (key: string, left: JSX.Element, right: string, rightColor?: Look['color']): JSX.Element => (
      <Box key={key} flexDirection="row" justifyContent="space-between" width={width}>
        {left}
        <Text color={rightColor} dimColor={rightColor === undefined}>{right}</Text>
      </Box>
    )
    const toggleRow = (key: string, label: string, open: boolean, indent = ''): JSX.Element => (
      <Button key={key} plain label={label} onPress={flip(key)}>
        {fit(`${indent}${open ? '▼' : '▶'} ${label}`, width)}
      </Button>
    )
    const blank = (key: string): JSX.Element => <Text key={key}> </Text>

    const stepRows = (steps: Step[]): JSX.Element[] =>
      steps.flatMap(step => {
        const look = STATUS_LOOK[step.status]
        const right = step.status === 'running' ? '…' : seconds(step.durationMs)
        const room = width - right.length - 5
        return [
          split(
            `step-${step.key}`,
            <Text wrap="truncate-end">
              <Text color={look.color}>{look.icon}</Text> {KIND_ICONS[step.kind]} {fit(step.title, room)}
            </Text>,
            right,
          ),
          ...(step.detail === '' ? [] : [line(`detail-${step.key}`, `    ${step.detail}`, { dimColor: true })]),
        ]
      })

    const commandRows = (entry: ToolEntry, keyPrefix: string): JSX.Element[] => {
      const verdict = verdictOf(entry)
      const summary = resultLine(entry)
      const outputOpen = isOpen(`${keyPrefix}-output`, false)
      const rows: JSX.Element[] = [line(`${keyPrefix}-cmd`, `$ ${oneLine(entry.command ?? '')}`, { color: 'permission' })]
      if (entry.status === 'running') rows.push(line(`${keyPrefix}-running`, `  ${ICONS.running} ejecutando…`, { color: 'warning' }))
      for (const test of entry.testFiles ?? []) {
        rows.push(
          <Text key={`${keyPrefix}-test-${test.file}`} wrap="truncate-end">
            {'  '}<Text color={test.ok ? 'success' : 'error'}>{test.ok ? ICONS.ok : ICONS.error}</Text> {fit(test.file, width - 6)}
          </Text>,
        )
      }
      if (entry.status !== 'running') {
        const look = verdict === 'FAIL' || entry.status !== 'ok' ? STATUS_LOOK.error : STATUS_LOOK.ok
        rows.push(
          <Text key={`${keyPrefix}-verdict`} wrap="truncate-end">
            <Text color={look.color} bold>{look.icon}{verdict ? ` ${verdict}` : ''}</Text>
            <Text dimColor> {fit(`${summary}${summary && entry.durationMs !== undefined ? ' · ' : ''}${seconds(entry.durationMs)}`, width - 8)}</Text>
          </Text>,
        )
      }
      if (entry.output !== '') {
        rows.push(toggleRow(`${keyPrefix}-output`, outputOpen ? 'Ocultar salida' : 'Ver salida completa', outputOpen))
        if (outputOpen) entry.output.split('\n').forEach((out, index) => rows.push(line(`${keyPrefix}-out-${index}`, `  ${out}`, { dimColor: true })))
      }
      return rows
    }

    const historyRows = (): JSX.Element[] =>
      commands
        .slice()
        .reverse()
        .map(entry => {
          const look = STATUS_LOOK[entry.status]
          const right = entry.status === 'running' ? '…' : `exit ${entry.exitCode ?? '?'} · ${seconds(entry.durationMs)}`
          return split(
            `hist-${entry.id}`,
            <Text wrap="truncate-end">
              {'  '}<Text color={look.color}>{look.icon}</Text> {fit(oneLine(entry.command ?? ''), width - right.length - 7)}
            </Text>,
            right,
          )
        })

    const changeRows = (): JSX.Element[] => {
      if (scopedFiles.length === 0) return [line('no-changes', scope === MAIN ? 'Sin cambios sin commitear.' : 'Este agente no tiene cambios sin commitear.', { dimColor: true })]
      return scopedFiles.flatMap(file => {
        const isOpenFile = opened.includes(file.path)
        const counts = `+${file.added} −${file.removed}`
        const rows: JSX.Element[] = [
          <Box key={`file-${file.path}`} flexDirection="row" justifyContent="space-between" width={width}>
            <Box flexDirection="row" gap={1}>
              <Button key={`fold-${file.path}`} plain label={isOpenFile ? 'Ocultar diff' : 'Ver diff aquí'} onPress={() => void toggleFile(file.path)()}>
                {isOpenFile ? '▾' : '▸'}
              </Button>
              <Button key={`open-${file.path}`} plain label={`Abrir ${file.path} en nvim`} onPress={() => void openInEditor(file.path)()}>
                {fileIcon(file.path)} {fit(file.path, width - counts.length - 7)}
              </Button>
            </Box>
            <Text>
              <Text color="success">+{file.added}</Text> <Text color="error">−{file.removed}</Text>
            </Text>
          </Box>,
        ]
        if (!isOpenFile) return rows
        const patch = diffRows(patches[file.path] ?? '')
        const gutter = Math.max(3, ...patch.map(row => row.gutter.length))
        if (patch.length === 0) rows.push(line(`nodiff-${file.path}`, '  Sin diferencias contra HEAD.', { dimColor: true }))
        patch.slice(0, DIFF_LINES).forEach((row, index) =>
          rows.push(
            row.kind === 'hunk' ? (
              line(`hunk-${file.path}-${index}`, `  ${row.sign} ${row.text}`, { color: 'suggestion' })
            ) : (
              <Text key={`row-${file.path}-${index}`} wrap="truncate-end">
                <Text dimColor>  {row.gutter.padStart(gutter)} │</Text>
                <Text color={row.kind === 'add' ? 'diffAdded' : row.kind === 'del' ? 'diffRemoved' : undefined}>
                  {row.sign} {fit(row.text, width - gutter - 8)}
                </Text>
              </Text>
            ),
          ),
        )
        if (patch.length > DIFF_LINES) rows.push(line(`more-${file.path}`, `  … ${patch.length - DIFF_LINES} líneas más`, { dimColor: true }))
        return rows
      })
    }

    const section = (key: string, label: string, byDefault: boolean, body: () => JSX.Element[]): JSX.Element[] => {
      const open = isOpen(key, byDefault)
      return [toggleRow(key, label, open), ...(open ? body() : [])]
    }

    const decisions = scoped.flatMap(one => one.decisions ?? [])
    const readFiles = distinct(scoped.filter(one => one.tool === 'Read').map(one => one.file)).reverse()
    const divider = (key: string): JSX.Element => line(key, '─'.repeat(width), { dimColor: true })

    const summaryRows = (): JSX.Element[] => {
      const steps = groupSteps(scoped)
      if (steps.length === 0) return [line('empty', 'Sin actividad todavía.', { dimColor: true })]
      return [
        ...stepRows(steps),
        ...(lastCommand ? [blank('gap-last'), ...section(`last-cmd-${scope}`, 'Último comando', true, () => commandRows(lastCommand, `last-${scope}`))] : []),
        blank('gap-changes'),
        divider('div-changes'),
        line('changes-title', `${ICONS.folder} CAMBIOS`, { bold: true }),
        ...changeRows(),
        blank('gap-sections'),
        ...section(`decisions-${scope}`, `Decisiones técnicas · ${decisions.length}`, false, () =>
          decisions.length === 0
            ? [line('no-decisions', '  Sin preguntas todavía.', { dimColor: true })]
            : decisions.flatMap((one, index) => [
                line(`q-${index}`, `  ${ICONS.question} ${one.question}`),
                line(`a-${index}`, `    → ${one.answer || 'pendiente'}`, { color: one.answer ? 'success' : 'warning' }),
              ]),
        ),
        ...section(`history-${scope}`, `${scope === MAIN ? 'Historial de comandos' : 'Historial de este agente'} · ${commands.length}`, false, historyRows),
        ...section(`context-${scope}`, 'Contexto consultado', false, () => [
          line('ctx-percent', `  Contexto usado: ${Math.round(percent)}%`, { dimColor: true }),
          ...readFiles.slice(0, 30).map(path => line(`ctx-${path}`, `  ${fileIcon(path)} ${path}`)),
        ]),
      ]
    }

    const commandsTabRows = (): JSX.Element[] => {
      if (!lastCommand) return [line('no-commands', 'Sin comandos todavía.', { dimColor: true })]
      return [
        line('last-title', `${ICONS.command} Último comando`, { bold: true }),
        ...commandRows(lastCommand, `cmdtab-${scope}`),
        blank('gap-history'),
        line('history-title', `${ICONS.history} Historial · ${commands.length}`, { bold: true }),
        ...historyRows(),
      ]
    }

    const body = current === 'diff' ? changeRows() : current === 'commands' ? commandsTabRows() : summaryRows()

    const statusText = waiting
      ? { value: `${ICONS.waiting} esperando respuesta`, color: 'warning' as const }
      : isWorking
        ? { value: `${ICONS.running} ejecutando`, color: 'warning' as const }
        : undefined

    const header: JSX.Element[] = [
      <Box key="title" flexDirection="row" justifyContent="space-between" width={width}>
        <Text bold>ACTIVIDAD</Text>
        {statusText ? <Text color={statusText.color}>{statusText.value}</Text> : <Text> </Text>}
      </Box>,
    ]
    if (records.length > 0) {
      const chip = (id: string, label: string, look?: Look) => (
        <Button key={`agent-${id}`} plain label={label} onPress={() => void pickAgent(id)()}>
          <Text inverse={scope === id} bold={scope === id}> {label}{look ? ' ' : ''}</Text>
          {look ? <Text color={look.color} inverse={scope === id}>{look.icon} </Text> : <Text inverse={scope === id}> </Text>}
        </Button>
      )
      header.push(
        <Box key="agents" flexDirection="row" gap={1} width={width} overflow="hidden">
          {chip(MAIN, 'Principal')}
          {records.map(one => chip(one.id, shortName(one), AGENT_LOOK[one.state]))}
        </Box>,
      )
    }
    if (agent) {
      const look = AGENT_LOOK[agent.state]
      header.push(
        <Text key="agent-head" wrap="truncate-end">
          <Text color="claude" bold>{ICONS.agent} {shortName(agent)}</Text>
          <Text dimColor> · {agent.id.slice(0, 4)} · </Text>
          <Text color={look.color}>{look.label}</Text>
        </Text>,
        line('agent-task', agent.description, { dimColor: true }),
      )
    }
    header.push(
      <Box key="tabs" flexDirection="row" gap={1} width={width}>
        {TAB_LABELS.map(tab => (
          <Button key={`tab-${tab.value}`} plain label={tab.label} onPress={() => void pickTab(tab.value)()}>
            <Text inverse={current === tab.value} bold={current === tab.value} color={current === tab.value ? 'claude' : undefined}>
              {` ${tab.icon} ${tab.label} `}
            </Text>
          </Button>
        ))}
      </Box>,
      divider('div-head'),
    )

    const totalMs = list.reduce((sum, one) => sum + (one.durationMs ?? 0), 0)
    const commandCount = list.filter(one => one.command !== undefined).length
    const footer: JSX.Element[] = [
      divider('div-foot'),
      line('footer', `${files.length} archivos · ${commandCount} comandos · ${seconds(totalMs) || '0.0 s'} · ${ICONS.cost} ${dollars(usd)} estimado`, { dimColor: true }),
    ]

    const room = Math.max(1, e.props.scroll.bodyRows - header.length - footer.length)
    layout = { total: body.length, room }
    const start = windowStart(view, body.length, room)
    const visible = body.slice(start, start + room)
    const padding = Array.from({ length: room - visible.length }, (_, index) => blank(`pad-${index}`))
    if (body.length > room) {
      header[0] = (
        <Box key="title" flexDirection="row" justifyContent="space-between" width={width}>
          <Text bold>ACTIVIDAD {statusText ? <Text color={statusText.color}>{statusText.value}</Text> : ''}</Text>
          <Text dimColor>↕ {start + 1}-{start + visible.length}/{body.length}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        {header}
        {visible}
        {padding}
        {footer}
      </Box>
    )
  })
}
