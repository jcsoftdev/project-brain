import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type {
  AgentRecord,
  AgentState,
  BranchCommit,
  BranchView,
  CallStatus,
  CambiosScope,
  CommitCall,
  CommitRecord,
  ContextUsage,
  StepContext,
  Decision,
  DiffPatch,
  DiffRow,
  EditorState,
  FileChange,
  HistoryFiles,
  HistoryRow,
  HistoryView,
  PaneScroll,
  Tab,
  TestFile,
  ToolEntry,
} from '../types'

const PANE = 'activity'
const PANE_ARGS = { id: PANE, title: 'Actividad', columns: 1000 } as const
const MAIN = 'main'
const KEEP = 300
const OUTPUT_LINES = 40
const DIFF_LINES = 120
const TEST_FILES = 30
const UNTRACKED_MAX = 100
const COMMIT_FILES = 100
const BRANCH_COMMITS = 100
const OPEN_DIFFS = 40
const REFRESH_MS = 400
const RESCAN_MS = 800
const SCAN_COMMITS = 200
const COMMIT_CALLS = 100
const HISTORY_COMMITS = 400
const HISTORY_FILES = 40
const WINDOW_SLACK_MS = 2000
const SUMMARY_FIELDS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'] as const
const ENVELOPE_FIELDS = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta'])
const CHANGE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export const ICONS = {
  summary: '\u{F0756}',
  commands: '\u{E795}',
  diff: '\u{F4D2}',
  history: '\u{F02A2}',
  ok: '\u{F00C}',
  error: '\u{F00D}',
  running: '\u{F0996}',
  denied: '\u{F05E}',
  interrupted: '\u{F073A}',
  waiting: '\u{F252}',
  agent: '\u{F06A9}',
  cost: '\u{F01C1}',
  time: '\u{F051B}',
  files: '\u{F0222}',
  gauge: '\u{F029A}',
  brain: '\u{F09D1}',
  question: '\u{F02D7}',
  decision: '\u{F062C}',
  read: '\u{F0349}',
  edit: '\u{F03EB}',
  validate: '\u{F0668}',
  command: '\u{E795}',
  other: '\u{F0EB}',
  log: '\u{F1DA}',
  folder: '\u{F07C}',
  file: '\u{F016}',
  commit: '\u{E729}',
  merge: '\u{E727}',
  branch: '\u{E725}',
  uncommitted: '\u{F11E7}',
  hunk: '\u{F4D2}',
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

const entries = atom({ plugin: 'project-brain-activity', key: 'entries' } as const, [] as ToolEntry[], { shape: 'entries-4' })
const tabs = atom({ plugin: 'project-brain-activity', key: 'tabs' } as const, {} as Record<string, Tab>, { shape: 'tabs-1' })
const toggled = atom({ plugin: 'project-brain-activity', key: 'toggled' } as const, [] as string[], { shape: 'toggled-2' })
const changes = atom({ plugin: 'project-brain-activity', key: 'changes' } as const, [] as FileChange[], { shape: 'changes-2' })
const openFiles = atom({ plugin: 'project-brain-activity', key: 'openFiles' } as const, [] as string[], { shape: 'open-files-2' })
const diffs = atom({ plugin: 'project-brain-activity', key: 'diffs' } as const, {} as Record<string, DiffPatch>, { shape: 'diffs-2' })
const costUsd = atom({ plugin: 'project-brain-activity', key: 'costUsd' } as const, 0, { shape: 'cost-1' })
const stepContext = atom({ plugin: 'project-brain-activity', key: 'stepContext' } as const, {} as Record<string, StepContext>, { shape: 'step-context-1' })
const contextUsage = atom({ plugin: 'project-brain-activity', key: 'context' } as const, { window: 0 } as ContextUsage, { shape: 'context-2' })
const agents = atom({ plugin: 'project-brain-activity', key: 'agents' } as const, [] as AgentRecord[], { shape: 'agents-1' })
const pickedAgent = atom({ plugin: 'project-brain-activity', key: 'pickedAgent' } as const, '', { shape: 'picked-1' })
const working = atom({ plugin: 'project-brain-activity', key: 'working' } as const, false, { shape: 'working-1' })
const scroll = atom({ plugin: 'project-brain-activity', key: 'scroll' } as const, { offset: 0, follow: false } as PaneScroll, { shape: 'scroll-1' })
const commits = atom({ plugin: 'project-brain-activity', key: 'commits' } as const, [] as CommitRecord[], { shape: 'commits-1' })
const scopes = atom({ plugin: 'project-brain-activity', key: 'scopes' } as const, {} as Record<string, CambiosScope>, { shape: 'scopes-1' })
const branch = atom({ plugin: 'project-brain-activity', key: 'branch' } as const, { isLoaded: false, files: [], commits: [] } as BranchView, { shape: 'branch-1' })
const autoOpen = atom({ plugin: 'project-brain-activity', key: 'autoOpen' } as const, true, { shape: 'auto-open-1' })
const editor = atom({ plugin: 'project-brain-activity', key: 'editor' } as const, { dir: '', tab: '' } as EditorState, { shape: 'editor-1' })
const accentColor = atom({ plugin: 'project-brain-activity', key: 'accent' } as const, 'claude' as string, { shape: 'accent-1' })

/** Claude Code's session colours (/color) in the default theme; 'default' and unknown names keep the claude tone. */
const SESSION_COLORS: Record<string, string> = {
  red: 'rgb(220,38,38)', blue: 'rgb(106,155,204)', green: 'rgb(22,163,74)', yellow: 'rgb(202,138,4)',
  purple: 'rgb(130,125,189)', orange: 'rgb(217,119,87)', pink: 'rgb(196,102,134)', cyan: 'rgb(8,145,178)',
}

/** The last `"agentColor":"<name>"` grep match in the transcript, as a colour the pane can paint. */
export const accentOf = (grepOutput: string): string => {
  const names = [...grepOutput.matchAll(/"agentColor":"([a-z]+)"/g)].map(match => match[1] ?? '')
  return SESSION_COLORS[names.at(-1) ?? ''] ?? 'claude'
}

/** Reads the session colour Claude Code writes into the transcript as an `agent-color` entry. */
const refreshAccent = async ($: Api): Promise<void> => {
  const [id, root, home] = await Promise.all([
    $.session.id(),
    $.session.root(),
    $.process.run(['/usr/bin/printenv', 'HOME']).then(out => out.stdout.trim()).catch(() => ''),
  ])
  if (!home || !/^[0-9a-f-]{36}$/.test(id)) return
  const transcript = `${home}/.claude/projects/${root.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`
  const found = await $.process.run(['/usr/bin/grep', '-a', '-o', '"agentColor":"[a-z]*"', transcript], { timeoutMs: 3000 }).catch(() => undefined)
  if (!found) return
  const next = accentOf(found.stdout)
  if (next !== (await read($, accentColor))) await update($, accentColor, () => next)
}

const sessionStart = atom({ plugin: 'project-brain-activity', key: 'sessionStart' } as const, 0, { shape: 'session-start-1' })
const commitCalls = atom({ plugin: 'project-brain-activity', key: 'commitCalls' } as const, [] as CommitCall[], { shape: 'commit-calls-1' })
const history = atom({ plugin: 'project-brain-activity', key: 'history' } as const, { state: 'idle', rows: [], more: 0, loadedAt: 0 } as HistoryView, { shape: 'history-1' })
const historyFiles = atom({ plugin: 'project-brain-activity', key: 'historyFiles' } as const, {} as Record<string, HistoryFiles>, { shape: 'history-files-1' })

type Api = Parameters<Hook<'turn.complete'>>[0]

// Timers are not drawn state: a reload dropping them only loses one debounce.
let refreshTimer: { cancel: () => void } | undefined
let autoOpenSent = false
let rescanTimer: { cancel: () => void } | undefined
let scanning: Promise<void> | undefined
let scanAgain = false
let historyLoading: Promise<void> | undefined

// ---------------------------------------------------------------- text

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-_]/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
export const clean = (value: string): string => value.replace(ANSI, '').replace(/\t/g, '  ').replace(CONTROL, '')

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

export const oneLine = (raw: string): string => clean(raw).replace(/\s+/g, ' ').trim()

const cleanText = (value: unknown): string | undefined => {
  const found = text(value)
  return found === undefined ? undefined : oneLine(found)
}

export const summarize = (input: Record<string, unknown>): string => {
  const field = SUMMARY_FIELDS.find(name => text(input[name]) !== undefined)
  if (field) return oneLine(String(input[field])).slice(0, 200)
  const own = Object.fromEntries(Object.entries(input).filter(([name]) => !ENVELOPE_FIELDS.has(name)))
  return oneLine(JSON.stringify(own)).slice(0, 200)
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

export const compact = (count: number): string => {
  const trimmed = (value: number) => value.toFixed(1).replace(/\.0$/, '')
  if (count < 1000) return String(Math.round(count))
  if (count < 1_000_000) return count < 10_000 ? `${trimmed(count / 1000)}k` : `${Math.round(count / 1000)}k`
  return `${trimmed(count / 1_000_000)}M`
}

export const contextPercentOf = (usage: ContextUsage): number | undefined =>
  usage.tokens === undefined || usage.window <= 0 ? undefined : (usage.percent ?? (usage.tokens / usage.window) * 100)

export const contextLabel = (usage: ContextUsage): string => {
  if (usage.window <= 0) return usage.tokens === undefined ? 'Contexto: sin medir' : `Contexto: ${compact(usage.tokens)} tokens`
  const percent = contextPercentOf(usage)
  const tokens = usage.tokens === undefined ? '—' : compact(usage.tokens)
  return `Contexto: ${tokens} / ${compact(usage.window)} tokens${percent === undefined ? '' : ` (${Math.round(percent)} %)`}`
}

/**
 * The context of the selected loop: the session's own figures for the main loop; for a subagent, its last
 * model request (input + cache written + cache read) over the main window when it runs the same model.
 */
export const scopedContext = (snap: Pick<Snapshot, 'context' | 'steps'>, scope: string): ContextUsage => {
  if (scope === MAIN) return snap.context
  const own = snap.steps[scope]
  if (own === undefined) return { window: snap.context.window }
  const sameModel = snap.steps[MAIN] !== undefined && snap.steps[MAIN].model === own.model
  return sameModel ? { tokens: own.tokens, window: snap.context.window } : { tokens: own.tokens, window: 0 }
}

export const contextBar = (percent: number | undefined): string => {
  const filled = percent === undefined ? 0 : Math.min(10, Math.max(0, Math.round(percent / 10)))
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled)
}

const contextTone = (percent: number | undefined): Tone =>
  percent === undefined ? 'subtle' : percent < 60 ? 'success' : percent <= 85 ? 'warning' : 'error'

// ---------------------------------------------------------------- commands

const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\||\n)\s*/

export const commandHeads = (command: string): string[] =>
  command
    .split(SEGMENT_SPLIT)
    .map(segment => segment.trim().replace(/^(?:[A-Za-z_]\w*=\S*\s+)*/, '').replace(/^(?:time|exec|command)\s+/, ''))
    .filter(Boolean)

const TEST_HEADS = [
  /^bun\s+(?:run\s+)?test\b/,
  /^(?:npx\s+|bunx\s+|yarn\s+|pnpm\s+(?:exec\s+|dlx\s+)?)?(?:vitest|jest)\b/,
  /^(?:python3?\s+-m\s+|uv\s+run\s+)?pytest\b/,
  /^go\s+test\b/,
  /^cargo\s+test\b/,
  /^(?:pnpm|npm|yarn)\s+(?:run\s+)?test\b/,
]

const CHECK_HEADS = [
  /^(?:npx\s+|bunx\s+|yarn\s+|pnpm\s+(?:exec\s+)?)?(?:tsc|eslint|biome)\b/,
  /^(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:lint|typecheck|check)\b/,
]

export const isTestCommand = (command: string): boolean => commandHeads(command).some(head => TEST_HEADS.some(pattern => pattern.test(head)))

export const isCheckCommand = (command: string): boolean => commandHeads(command).some(head => CHECK_HEADS.some(pattern => pattern.test(head)))

export const isValidationCommand = (command: string): boolean => isTestCommand(command) || isCheckCommand(command)

const WORD = String.raw`(?:'[^']*'|"[^"]*"|[^\s'"]+)`
const GIT_OPTION = String.raw`(?:\s+-[Cc]\s+${WORD}|\s+--?[\w-]+(?:=${WORD})?)`
const GIT_VERB = new RegExp(String.raw`^\(*\s*git(${GIT_OPTION}*)\s+(commit|merge|cherry-pick|revert)\b`)
const CD_HEAD = new RegExp(String.raw`^\(*\s*(?:cd|pushd)\s+(${WORD})\s*\)?$`)
const DASH_C = new RegExp(String.raw`\s-C\s+(${WORD})`, 'g')

const unquote = (word: string): string => word.replace(/^'([\s\S]*)'$/, '$1').replace(/^"([\s\S]*)"$/, '$1')

const joinDir = (base: string | undefined, next: string): string =>
  base === undefined || next.startsWith('/') || next.startsWith('~') ? next : `${base.replace(/\/+$/, '')}/${next}`

/** The git verbs that make a commit, in a command with any `cd`, `git -C` or global option before them. */
export const gitCommitVerbs = (command: string): string[] =>
  distinct(commandHeads(command).map(head => GIT_VERB.exec(head)?.[2]))

/**
 * The directory the first commit verb runs in, as the command names it: every
 * `cd` before it, then its own `-C` options. Undefined when it names none.
 */
export const commitDirOf = (command: string): string | undefined => {
  let dir: string | undefined
  for (const head of commandHeads(command)) {
    const cd = CD_HEAD.exec(head)
    if (cd?.[1] !== undefined) {
      dir = joinDir(dir, unquote(cd[1]))
      continue
    }
    const verb = GIT_VERB.exec(head)
    if (verb === null) continue
    for (const option of (verb[1] ?? '').matchAll(DASH_C)) dir = joinDir(dir, unquote(option[1] ?? ''))
    return dir
  }
  return undefined
}

export const exitCodeOf = (output: string | undefined, isError: boolean): number | undefined => {
  if (!isError) return 0
  const stated = /^\s*Exit code:?\s*(\d+)/i.exec(output ?? '')?.[1]
  return stated === undefined ? undefined : Number(stated)
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
  const validates = isValidationCommand(entry.command)
  if (validates && counts.failed !== undefined && counts.failed > 0) return 'FAIL'
  if (validates) return entry.exitCode === 0 ? 'PASS' : 'FAIL'
  return undefined
}

export const resultLine = (entry: ToolEntry): string => {
  const counts = isTestCommand(entry.command ?? '') ? testCounts(entry.output) : {}
  const parts: string[] = []
  if (counts.passed !== undefined) parts.push(`${counts.passed} pruebas`)
  if (counts.failed !== undefined && counts.failed > 0) parts.push(`${counts.failed} fallaron`)
  if (counts.pending !== undefined && counts.pending > 0) parts.push(`${counts.pending} ${counts.pending === 1 ? 'pendiente' : 'pendientes'}`)
  if (entry.exitCode !== undefined) parts.push(`exit ${entry.exitCode}`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------- git parsing

const SHA = /^[0-9a-f]{7,40}$/

export const parseNumstatZ = (stdout: string): FileChange[] =>
  stdout
    .split('\0')
    .map(record => record.replace(/^\n+/, ''))
    .map(record => /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(record))
    .filter((found): found is RegExpExecArray => found !== null)
    .map(([, added, removed, path]) => ({
      path: path ?? '',
      added: added === '-' ? 0 : Number(added),
      removed: removed === '-' ? 0 : Number(removed),
      ...(added === '-' ? { binary: true } : {}),
    }))

export const lineCount = (body: string): number => (body === '' ? 0 : body.split('\n').length - (body.endsWith('\n') ? 1 : 0))

export type FoundCommit = { sha: string; subject: string; branch: string }

const COMMIT_LINE = /^\[(.+?) ([0-9a-f]{7,40})\] (.*)$/

export const commitsIn = (command: string, output: string): FoundCommit[] => {
  if (gitCommitVerbs(command).length === 0) return []
  return clean(output)
    .split('\n')
    .map(line => COMMIT_LINE.exec(line.trim()))
    .filter((found): found is RegExpExecArray => found !== null)
    .map(([, name, sha, subject]) => ({ sha: sha ?? '', subject: oneLine(subject ?? ''), branch: oneLine((name ?? '').replace(/ \(root-commit\)$/, '')) }))
}

export const madeMergeCommit = (command: string, output: string): boolean =>
  gitCommitVerbs(command).includes('merge') && /^Merge made by/m.test(output)

export const addCommits = (list: CommitRecord[], found: FoundCommit[], agentId: string | undefined, at: number): CommitRecord[] => {
  const fresh = found.filter(one => SHA.test(one.sha) && !list.some(known => known.sha === one.sha))
  return [...list, ...fresh.map(one => ({ ...one, at, ...(agentId === undefined ? {} : { agentId }) }))].slice(-200)
}

export const parseLogZ = (stdout: string): BranchCommit[] =>
  stdout
    .split('\0')
    .map(record => record.replace(/^\n+/, '').split('\u001f'))
    .filter(([sha]) => sha !== undefined && SHA.test(sha))
    .map(([sha, subject]) => ({ sha: sha ?? '', subject: oneLine(subject ?? '') }))

export const diffRows = (patch: string): DiffRow[] => {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      rows.push({ gutter: '', sign: '@@', text: clean(`línea ${newLine}${hunk[3] ?? ''}`), kind: 'hunk' })
      continue
    }
    if (rows.length === 0 || raw.startsWith('\\')) continue
    const sign = raw.charAt(0)
    const body = clean(raw.slice(1))
    if (sign === '+') rows.push({ gutter: String(newLine++), sign: '+', text: body, kind: 'add' })
    else if (sign === '-') rows.push({ gutter: String(oldLine++), sign: '-', text: body, kind: 'del' })
    else if (sign === ' ') { rows.push({ gutter: String(newLine), sign: ' ', text: body, kind: 'same' }); oldLine++; newLine++ }
  }
  return rows
}

// ---------------------------------------------------------------- git loaders

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Run = (argv: readonly string[], init?: { cwd?: string; timeoutMs?: number; stdin?: string }) => Promise<RunResult>
export type ReadText = (path: string) => Promise<string>

const quietly = (run: Run, argv: readonly string[], cwd?: string, stdin?: string): Promise<RunResult | undefined> =>
  run(argv, cwd === undefined && stdin === undefined ? undefined : { ...(cwd === undefined ? {} : { cwd }), ...(stdin === undefined ? {} : { stdin }) }).catch(() => undefined)

export const gitTop = async (run: Run, cwd?: string): Promise<string | undefined> => {
  const found = await quietly(run, ['git', 'rev-parse', '--show-toplevel'], cwd)
  return found?.exitCode === 0 ? found.stdout.replace(/\n$/, '') : undefined
}

export const loadUncommitted = async (run: Run, top: string, readText: ReadText): Promise<FileChange[] | undefined> => {
  const head = await quietly(run, ['git', 'rev-parse', '--verify', '-q', 'HEAD'], top)
  const base = head?.exitCode === 0 ? 'HEAD' : EMPTY_TREE
  const tracked = await quietly(run, ['git', 'diff', '--numstat', '-z', '--no-renames', base], top)
  if (tracked?.exitCode !== 0) return undefined
  const others = await quietly(run, ['git', 'ls-files', '--others', '--exclude-standard', '-z'], top)
  const paths = others?.exitCode === 0 ? others.stdout.split('\0').filter(Boolean).slice(0, UNTRACKED_MAX) : []
  const untracked = await Promise.all(
    paths.map(async (path): Promise<FileChange> => {
      const body = await readText(`${top}/${path}`).catch(() => undefined)
      const isBinary = body === undefined || body.includes('\0')
      return { path, added: isBinary ? 0 : lineCount(body), removed: 0, untracked: true, ...(isBinary ? { binary: true } : {}) }
    }),
  )
  return [...parseNumstatZ(tracked.stdout), ...untracked]
}

export type CommitStats = { added: number; removed: number; files: FileChange[]; isMerge: boolean }

export const loadCommitStats = async (run: Run, top: string, sha: string): Promise<CommitStats | undefined> => {
  if (!SHA.test(sha)) return undefined
  const shown = await quietly(run, ['git', 'show', '--numstat', '-z', '--no-renames', '--diff-merges=first-parent', '--format=', sha], top)
  if (shown?.exitCode !== 0) return undefined
  const parents = await quietly(run, ['git', 'show', '-s', '--format=%P', sha], top)
  const files = parseNumstatZ(shown.stdout)
  return {
    added: files.reduce((sum, one) => sum + one.added, 0),
    removed: files.reduce((sum, one) => sum + one.removed, 0),
    files: files.slice(0, COMMIT_FILES),
    isMerge: (parents?.stdout.trim().split(/\s+/).filter(Boolean).length ?? 0) > 1,
  }
}

export const loadHeadCommit = async (run: Run, top: string): Promise<FoundCommit | undefined> => {
  const head = await quietly(run, ['git', 'log', '-1', '--format=%h%x1f%s', 'HEAD'], top)
  const name = await quietly(run, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], top)
  const [sha, subject] = (head?.stdout ?? '').replace(/\n$/, '').split('\u001f')
  if (head?.exitCode !== 0 || sha === undefined || !SHA.test(sha)) return undefined
  return { sha, subject: oneLine(subject ?? ''), branch: oneLine(name?.stdout ?? '') }
}

const BASE_REFS = ['main', 'master', 'origin/main', 'origin/master']

export const loadBranch = async (run: Run, top: string): Promise<BranchView> => {
  for (const ref of BASE_REFS) {
    const exists = await quietly(run, ['git', 'rev-parse', '--verify', '-q', `${ref}^{commit}`], top)
    if (exists?.exitCode !== 0) continue
    const merged = await quietly(run, ['git', 'merge-base', 'HEAD', ref], top)
    const base = merged?.stdout.trim() ?? ''
    if (merged?.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(base)) continue
    const numstat = await quietly(run, ['git', 'diff', '--numstat', '-z', '--no-renames', `${base}...HEAD`], top)
    const log = await quietly(run, ['git', 'log', '-z', `-n${BRANCH_COMMITS}`, '--format=%h%x1f%s', `${base}..HEAD`], top)
    return { isLoaded: true, baseRef: ref, base, files: parseNumstatZ(numstat?.stdout ?? ''), commits: parseLogZ(log?.stdout ?? '') }
  }
  return { isLoaded: true, files: [], commits: [], error: 'No encontré main ni master para comparar la rama.' }
}

// ---------------------------------------------------------------- session commits

export type ScannedCommit = { sha: string; subject: string; at: number; isMerge: boolean; branch: string; agentId?: string }
export type Worktree = { path: string; branch?: string; head?: string }

export const SCAN_FORMAT = '--format=%H%x1f%ct%x1f%P%x1f%s'

export const parseScanZ = (stdout: string): Omit<ScannedCommit, 'branch'>[] =>
  stdout
    .split('\0')
    .map(record => record.replace(/^\n+/, '').split('\u001f'))
    .filter(([sha, at]) => sha !== undefined && /^[0-9a-f]{40,64}$/.test(sha) && /^\d+$/.test(at ?? ''))
    .map(([sha, at, parents, ...subject]) => ({
      sha: sha ?? '',
      at: Number(at) * 1000,
      isMerge: (parents ?? '').trim().split(/\s+/).filter(Boolean).length > 1,
      subject: oneLine(subject.join(' ')),
    }))

export const parseWorktrees = (porcelain: string): Worktree[] =>
  porcelain
    .split(/\n\s*\n/)
    .map(block => {
      const lines = block.split('\n')
      const value = (name: string) => lines.find(one => one.startsWith(`${name} `))?.slice(name.length + 1)
      const path = value('worktree')
      const branchRef = value('branch')
      const head = value('HEAD')
      return path === undefined || !SAFE_PATH.test(path)
        ? undefined
        : { path, ...(branchRef ? { branch: oneLine(branchRef.replace(/^refs\/heads\//, '')) } : {}), ...(head ? { head } : {}) }
    })
    .filter((one): one is Worktree => one !== undefined)

/** `git name-rev --name-only` lines, one per sha in order: `main~2` names `main`. */
export const parseNameRev = (stdout: string, shas: string[]): Record<string, string> => {
  const names = stdout.split('\n')
  return Object.fromEntries(
    shas
      .map((sha, index) => [sha, oneLine((names[index] ?? '').replace(/[~^].*$/, ''))] as const)
      .filter(([, name]) => name !== '' && name !== 'undefined'),
  )
}

/**
 * Who made a commit the rescan found: the agent whose commit-verb call was
 * running when it was made (preferring one in the commit's worktree); else the
 * agent whose latest commit-verb call ran in that worktree; else the main loop.
 */
export const attributeCommit = (commit: Pick<ScannedCommit, 'at' | 'branch'>, calls: CommitCall[], worktrees: Worktree[]): string | undefined => {
  const tree = worktrees.find(one => one.branch !== undefined && one.branch === commit.branch)?.path
  const during = calls.filter(call => call.startedAt - WINDOW_SLACK_MS <= commit.at && commit.at <= call.endedAt + WINDOW_SLACK_MS)
  const inTree = tree === undefined ? [] : during.filter(call => call.top === tree)
  const owners = distinct((inTree.length > 0 ? inTree : during).map(call => call.agentId ?? MAIN))
  if (owners.length === 1) return owners[0] === MAIN ? undefined : owners[0]
  if (tree === undefined) return undefined
  const there = calls.filter(call => call.top === tree).sort((a, b) => a.startedAt - b.startedAt)
  const latest = there.filter(call => call.startedAt <= commit.at + WINDOW_SLACK_MS).at(-1) ?? there.at(-1)
  return latest?.agentId
}

const sameSha = (a: string, b: string): boolean => a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a))

/** Adds what the rescan found to the list, keyed by sha: a commit already known keeps its agent. */
export const mergeScanned = (list: CommitRecord[], found: ScannedCommit[]): CommitRecord[] => {
  const merged = list.map(known => {
    const same = found.find(one => sameSha(known.sha, one.sha))
    return same !== undefined && known.branch === '' ? { ...known, branch: same.branch } : known
  })
  for (const one of found) {
    if (merged.some(known => sameSha(known.sha, one.sha))) continue
    merged.push({
      sha: one.sha,
      subject: one.subject,
      branch: one.branch,
      at: one.at,
      ...(one.isMerge ? { isMerge: true } : {}),
      ...(one.agentId === undefined ? {} : { agentId: one.agentId }),
    })
  }
  return merged.sort((a, b) => a.at - b.at).slice(-SCAN_COMMITS)
}

export type SessionScan = { repo: string; commits: ScannedCommit[] }

/** Every commit this user made since `since`, on any branch of any worktree of the session's repository. */
export const scanSessionCommits = async (run: Run, since: number, calls: CommitCall[]): Promise<SessionScan | undefined> => {
  const top = await gitTop(run)
  if (top === undefined) return undefined
  const common = await quietly(run, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], top)
  const repo = common?.exitCode === 0 && SAFE_PATH.test(common.stdout.trim()) ? common.stdout.trim() : top
  const email = (await quietly(run, ['git', 'config', 'user.email'], top))?.stdout.trim() ?? ''
  const author = email !== '' && SAFE_PATH.test(email) ? ['-F', `--author=<${email}>`] : []
  const log = await quietly(run, ['git', 'log', '--all', `--since=@${Math.floor(since / 1000)}`, ...author, '-z', `-n${SCAN_COMMITS}`, SCAN_FORMAT], repo)
  if (log?.exitCode !== 0) return undefined
  const found = parseScanZ(log.stdout)
  if (found.length === 0) return { repo, commits: [] }
  const listed = await quietly(run, ['git', 'worktree', 'list', '--porcelain'], repo)
  const worktrees = listed?.exitCode === 0 ? parseWorktrees(listed.stdout) : []
  const shas = found.map(one => one.sha)
  const named = await quietly(run, ['git', 'name-rev', '--name-only', '--refs=refs/heads/*', ...shas], repo)
  const branches = named?.exitCode === 0 ? parseNameRev(named.stdout, shas) : {}
  return {
    repo,
    commits: found.map(one => {
      const branchName = branches[one.sha] ?? ''
      const agentId = attributeCommit({ at: one.at, branch: branchName }, calls, worktrees)
      return { ...one, branch: branchName, ...(agentId === undefined ? {} : { agentId }) }
    }),
  }
}

// ---------------------------------------------------------------- history

export const HISTORY_FORMAT = '--format=%x1e%h%x1f%D%x1f%ct%x1f%an%x1f%s'

export const parseGraphLog = (stdout: string): HistoryRow[] =>
  stdout
    .split('\n')
    .filter(raw => raw.trim() !== '')
    .map((raw): HistoryRow => {
      const mark = raw.indexOf('\u001e')
      const [sha, refs, at, author, ...subject] = mark < 0 ? [] : raw.slice(mark + 1).split('\u001f')
      if (mark < 0 || sha === undefined || !SHA.test(sha)) return { graph: clean(raw).trimEnd() }
      return {
        graph: clean(raw.slice(0, mark)),
        sha,
        refs: (refs ?? '').split(', ').map(oneLine).filter(Boolean),
        subject: oneLine(subject.join(' ')),
        ...(/^\d+$/.test(at ?? '') ? { at: Number(at) } : {}),
        author: oneLine(author ?? ''),
      }
    })

export const loadHistory = async (run: Run, now: number): Promise<HistoryView> => {
  const top = await gitTop(run)
  if (top === undefined) return { state: 'error', rows: [], more: 0, loadedAt: now, error: 'No hay repositorio git aquí.' }
  const log = await quietly(run, ['git', 'log', '--graph', '--all', '--date-order', '--no-color', `-n${HISTORY_COMMITS}`, HISTORY_FORMAT], top)
  if (log?.exitCode !== 0) {
    const reason = oneLine(log?.stderr ?? '').slice(0, 160)
    return { state: 'error', rows: [], more: 0, loadedAt: now, error: `git log falló${reason ? `: ${reason}` : '.'}` }
  }
  const rows = parseGraphLog(log.stdout)
  const shown = rows.filter(row => row.sha !== undefined).length
  const counted = await quietly(run, ['git', 'rev-list', '--all', '--count'], top)
  const total = counted?.exitCode === 0 ? Number(counted.stdout.trim()) : shown
  return { state: 'ready', rows, more: Number.isFinite(total) ? Math.max(0, total - shown) : 0, loadedAt: now }
}

export const ago = (atSeconds: number | undefined, nowMs: number): string => {
  if (atSeconds === undefined) return ''
  const minutes = Math.max(0, Math.round((nowMs / 1000 - atSeconds) / 60))
  if (minutes < 1) return 'ahora'
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.round(hours / 24)
  if (days < 14) return `hace ${days} d`
  if (days < 60) return `hace ${Math.round(days / 7)} sem`
  if (days < 365) return `hace ${Math.round(days / 30)} meses`
  const years = Math.round(days / 365)
  return `hace ${years} ${years === 1 ? 'año' : 'años'}`
}

export type DiffTarget = { scope: 'uncommitted' | 'commit' | 'branch'; path: string; sha?: string; untracked?: boolean }

export const targetKey = (target: DiffTarget): string =>
  target.scope === 'commit' ? `c:${target.sha ?? ''}:${target.path}` : `${target.scope === 'branch' ? 'b' : 'u'}:${target.path}`

export const diffArgv = (target: DiffTarget): string[] | undefined => {
  const plain = ['--no-color', '--no-ext-diff']
  if (target.scope === 'uncommitted' && target.untracked) return ['git', 'diff', '--no-index', ...plain, '--', '/dev/null', target.path]
  if (target.scope === 'uncommitted') return ['git', '--literal-pathspecs', 'diff', ...plain, 'HEAD', '--', target.path]
  if (target.sha === undefined || !/^[0-9a-f]{7,64}$/.test(target.sha)) return undefined
  if (target.scope === 'commit') return ['git', '--literal-pathspecs', 'show', ...plain, '--diff-merges=first-parent', '--format=', target.sha, '--', target.path]
  return ['git', '--literal-pathspecs', 'diff', ...plain, `${target.sha}...HEAD`, '--', target.path]
}

export const fetchDiff = async (run: Run, top: string, target: DiffTarget): Promise<DiffPatch> => {
  const argv = diffArgv(target)
  const shown = argv ? await quietly(run, argv, top) : undefined
  const rows = shown !== undefined && shown.exitCode <= 1 ? diffRows(shown.stdout) : []
  return { rows: rows.slice(0, DIFF_LINES), total: rows.length }
}

// ---------------------------------------------------------------- editor

/** POSIX single quoting: the one quoting helper every command string uses. */
export const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const SAFE_PATH = /^[^\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/
const SAFE_DIR = /^[\w./-]+$/
const SAFE_BASE = /^(?:HEAD|[0-9a-f]{7,64})(?:~1)?$/
const SAFE_TAB = /^[\w-]{1,64}$/

export const diffCommand = (base: string): string =>
  `lua vim.defer_fn(function() pcall(vim.cmd, "Gitsigns diffthis ${base}") end, 200)`

export const RESET_KEYS = '<C-\\><C-n>:silent! diffoff! | only<CR>'

export const diffKeys = (base: string): string => `<C-\\><C-n>:${diffCommand(base)}<CR>`

export type EditorRequest = { top: string; path: string; base: string; editor: EditorState }
export type EditorOutcome = { ok: boolean; message?: string; editor?: EditorState }

const ENV_NAMES = ['TMPDIR', 'XDG_RUNTIME_DIR', 'SUPACODE_SOCKET_PATH', 'TMUX'] as const

const readEnv = async (run: Run): Promise<Record<(typeof ENV_NAMES)[number], string>> => {
  const values = await Promise.all(ENV_NAMES.map(name => quietly(run, ['printenv', name])))
  return Object.fromEntries(ENV_NAMES.map((name, index) => [name, values[index]?.exitCode === 0 ? (values[index]?.stdout ?? '').replace(/\n$/, '') : ''])) as Record<(typeof ENV_NAMES)[number], string>
}

/**
 * Opens `path` in one nvim per session, reused on every call. Every piece of
 * data travels as its own argv item; the only command string is the one a
 * terminal multiplexer needs, and every item in it goes through shQuote.
 */
export const openInEditor = async (run: Run, exists: (path: string) => Promise<boolean>, request: EditorRequest): Promise<EditorOutcome> => {
  if (!SAFE_PATH.test(request.path) || !SAFE_PATH.test(request.top)) return { ok: false, message: 'Ese nombre de archivo no se puede abrir en el editor.' }
  if (!SAFE_BASE.test(request.base)) return { ok: false, message: 'Referencia de git no válida.' }
  const file = `${request.top}/${request.path}`
  const env = await readEnv(run)

  let dir = request.editor.dir
  if (dir !== '' && !(await isPrivateDir(run, dir))) dir = ''
  if (dir === '' || !(await exists(dir).catch(() => false))) {
    const base = (env.XDG_RUNTIME_DIR || env.TMPDIR || '/tmp').replace(/\/+$/, '')
    const made = await quietly(run, ['mktemp', '-d', `${base}/pb-nvim.XXXXXX`])
    dir = made?.exitCode === 0 ? made.stdout.trim() : ''
    if (dir === '' || !SAFE_DIR.test(dir)) return { ok: false, message: 'No se pudo crear la carpeta privada del editor.' }
  }
  const sock = `${dir}/nvim.sock`
  const state: EditorState = { dir, tab: dir === request.editor.dir ? request.editor.tab : '' }

  const alive = await quietly(run, ['nvim', '--server', sock, '--remote-expr', '1'])
  if (alive?.exitCode === 0) {
    await quietly(run, ['nvim', '--server', sock, '--remote-send', RESET_KEYS])
    const opened = await quietly(run, ['nvim', '--server', sock, '--remote', file])
    if (opened?.exitCode !== 0) return { ok: false, message: 'nvim no pudo abrir el archivo.', editor: state }
    await quietly(run, ['nvim', '--server', sock, '--remote-send', diffKeys(request.base)])
    if (state.tab !== '' && env.SUPACODE_SOCKET_PATH !== '') await quietly(run, ['supacode', 'tab', 'focus', '-t', state.tab])
    return { ok: true, editor: state }
  }

  await quietly(run, ['rm', '-f', '--', sock])
  const launcher = `${dir}/open.sh`
  const script = `#!/bin/sh\ncd ${shQuote(request.top)} && exec nvim --listen ${shQuote(sock)} ${shQuote(`+${diffCommand(request.base)}`)} -- ${shQuote(file)}\n`
  const written = await quietly(run, ['sh', '-c', 'umask 077 && cat > "$1"', 'write-launcher', launcher], undefined, script)
  if (written?.exitCode !== 0) return { ok: false, message: 'No se pudo preparar el editor.', editor: state }
  const start = `/bin/sh ${launcher}`
  if (env.SUPACODE_SOCKET_PATH !== '') {
    const split = await quietly(run, ['supacode', 'pane', 'split', '-d', 'h', '-i', start])
    if (split?.exitCode === 0) {
      const tab = split.stdout.trim()
      return { ok: true, editor: { dir, tab: SAFE_TAB.test(tab) ? tab : '' } }
    }
  }
  if (env.TMUX !== '') {
    const split = await quietly(run, ['tmux', 'split-window', '-h', start])
    if (split?.exitCode === 0) return { ok: true, editor: { dir, tab: '' } }
  }
  const terminal = await quietly(run, [
    'osascript',
    '-e', 'on run argv',
    '-e', 'tell application "Terminal" to do script (item 1 of argv)',
    '-e', 'end run',
    start,
  ])
  return terminal?.exitCode === 0
    ? { ok: true, editor: { dir, tab: '' } }
    : { ok: false, message: 'No se pudo abrir el editor (sin Supacode, tmux ni Terminal).', editor: { dir, tab: '' } }
}

/** The socket directory is reused only while it is still ours: a directory, owned by this user, mode 0700. */
const isPrivateDir = async (run: Run, dir: string): Promise<boolean> => {
  if (!SAFE_DIR.test(dir)) return false
  const uid = (await quietly(run, ['id', '-u']))?.stdout.trim() ?? ''
  if (!/^\d+$/.test(uid)) return false
  const found = await quietly(run, ['find', dir, '-maxdepth', '0', '-type', 'd', '-user', uid, '-perm', '700'])
  return found?.exitCode === 0 && found.stdout.trim() === dir
}

export const editorBase = (target: DiffTarget): string =>
  target.scope === 'commit' ? `${target.sha ?? ''}~1` : target.scope === 'branch' ? (target.sha ?? '') : 'HEAD'

// ---------------------------------------------------------------- steps

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
  if (entry.tool === 'Bash') return isValidationCommand(entry.command ?? '') ? 'validate' : 'command'
  if (entry.tool === 'Agent' || entry.tool === 'Task') return 'agent'
  if (entry.tool === 'AskUserQuestion') return 'question'
  return 'other'
}

const SOLO_KINDS = new Set<StepKind>(['agent', 'question', 'other'])

const groupStatus = (group: ToolEntry[]): CallStatus => {
  if (group.some(one => one.status === 'running')) return 'running'
  if (group.some(one => one.status === 'error')) return 'error'
  if (group.some(one => one.status === 'interrupted')) return 'interrupted'
  if (group.some(one => one.status === 'denied')) return 'denied'
  return 'ok'
}

export const wallTime = (group: ToolEntry[]): number | undefined => {
  if (group.length === 0 || group.some(one => one.durationMs === undefined)) return undefined
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
  const hasTests = commands.some(isTestCommand)
  const passed = group.reduce((sum, one) => sum + (isTestCommand(one.command ?? '') ? (testCounts(one.output).passed ?? 0) : 0), 0)
  const parts = distinct([
    commands.some(command => commandHeads(command).some(head => /\btsc\b|typecheck/.test(head))) ? 'tipos' : undefined,
    commands.some(command => commandHeads(command).some(head => /\b(?:lint|eslint|biome)\b/.test(head))) ? 'lint' : undefined,
    hasTests ? (passed > 0 ? `${passed} pruebas` : 'pruebas') : undefined,
  ])
  const title = running ? (hasTests ? 'Ejecutando pruebas' : 'Ejecutando validaciones') : 'Ejecutó validaciones'
  return { title, detail: parts.join(' · ') }
}

const describeCommand = (group: ToolEntry[], running: boolean) => {
  const commands = group.map(one => one.command ?? '')
  const detail = commands.length === 1 ? (commands[0] ?? '') : `${commands.length} comandos: ${distinct(commands.map(command => command.split(' ')[0])).join(' · ')}`
  return { title: running ? 'Ejecutando comandos' : 'Ejecutó comandos', detail }
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
    return { key: items[0]?.id ?? kind, kind, status, durationMs: wallTime(items), ...describeStep(kind, items, status === 'running') }
  })
}

// ---------------------------------------------------------------- agents

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

export const mergeAgent = (list: AgentRecord[], record: AgentRecord): AgentRecord[] => {
  const known = list.find(one => one.id === record.id)
  const merged = known ? { ...known, ...record, startedAt: known.startedAt, description: record.description || known.description } : record
  return [...list.filter(one => one.id !== record.id), merged].slice(-30)
}

export const setAgentState = (list: AgentRecord[], id: string, state: AgentState): AgentRecord[] =>
  list.map(one => (one.id === id ? { ...one, state } : one))

const agentStateOf = (status: string): AgentState =>
  status === 'completed' || status === 'idle' ? 'done' : status === 'failed' || status === 'killed' ? 'failed' : 'running'

/** The Agent tool's own result: only a completed run is done; a launch is still running. */
export const agentResultState = (status: CallStatus, result: unknown): AgentState | undefined => {
  if (status !== 'ok') return 'failed'
  const reported = (result as { status?: unknown } | undefined)?.status
  if (reported === 'completed') return 'done'
  if (reported === 'async_launched' || reported === 'remote_launched' || reported === 'teammate_spawned') return 'running'
  return undefined
}

export const turnEndState = (reason: string): AgentState => (reason === 'answer' ? 'done' : 'failed')

export const decisionsOf = (input: Record<string, unknown>): Decision[] =>
  rawQuestions(input).map(question => ({ question: oneLine(question), answer: '' }))

const rawQuestions = (input: Record<string, unknown>): string[] =>
  (Array.isArray(input.questions) ? input.questions : [])
    .map(one => text((one as { question?: unknown }).question))
    .filter((question): question is string => question !== undefined)

/** Answers are keyed by the question text exactly as the model sent it. */
export const answered = (input: Record<string, unknown>, status: CallStatus, result: unknown): Decision[] => {
  const record = (result ?? {}) as { answers?: unknown; response?: unknown }
  const answers = (record.answers ?? {}) as Record<string, unknown>
  const response = cleanText(record.response)
  return rawQuestions(input).map(raw => {
    if (status !== 'ok') return { question: oneLine(raw), answer: 'rechazada', refused: true }
    const given = answers[raw]
    return { question: oneLine(raw), answer: given !== undefined && given !== '' ? oneLine(String(given)) : (response ?? '') }
  })
}

// ---------------------------------------------------------------- scroll

export const scrolled = (state: PaneScroll, by: number, total: number, room: number, isJump: boolean): PaneScroll => {
  const maxOffset = Math.max(0, total - room)
  const from = state.follow ? maxOffset : Math.min(state.offset, maxOffset)
  const step = isJump ? Math.sign(by) * total : Math.abs(by) >= room ? Math.sign(by) * Math.max(1, room - 1) : by
  const offset = Math.min(maxOffset, Math.max(0, from + step))
  return { offset, follow: maxOffset > 0 && offset === maxOffset }
}

export const windowStart = (state: PaneScroll, total: number, room: number): number => {
  const maxOffset = Math.max(0, total - room)
  return state.follow ? maxOffset : Math.min(state.offset, maxOffset)
}

// ---------------------------------------------------------------- pane model

export type Tone = 'success' | 'error' | 'warning' | 'subtle' | 'permission' | 'claude' | 'suggestion' | 'diffAdded' | 'diffRemoved'
export type Span = { text: string; color?: Tone | (string & {}); dim?: boolean; bold?: boolean; inverse?: boolean }
export type Action =
  | { kind: 'toggle'; key: string }
  | { kind: 'tab'; tab: Tab }
  | { kind: 'agent'; id: string }
  | { kind: 'scope'; scope: CambiosScope }
  | { kind: 'diff'; target: DiffTarget }
  | { kind: 'open'; target: DiffTarget }
  | { kind: 'commit'; sha: string }
export type Cell = { spans: Span[]; action?: Action; label?: string; key?: string }
export type Row = { key: string; cells: Cell[]; right?: Span[] }

export type Snapshot = {
  list: ToolEntry[]
  tabByAgent: Record<string, Tab>
  flipped: string[]
  files: FileChange[]
  usd: number
  context: ContextUsage
  steps: Record<string, StepContext>
  accent: string
  opened: string[]
  patches: Record<string, DiffPatch>
  records: AgentRecord[]
  picked: string
  isWorking: boolean
  commitList: CommitRecord[]
  scopeByAgent: Record<string, CambiosScope>
  branchView: BranchView
  view: PaneScroll
  historyView: HistoryView
  historyFiles: Record<string, HistoryFiles>
}

export type PaneModel = { header: Row[]; body: Row[]; footer: Row[]; scope: string; cambios: CambiosScope; tab: Tab }

type Look = { icon: string; color: Tone }

const STATUS_LOOK: Record<CallStatus, Look> = {
  running: { icon: ICONS.running, color: 'warning' },
  ok: { icon: ICONS.ok, color: 'success' },
  error: { icon: ICONS.error, color: 'error' },
  denied: { icon: ICONS.denied, color: 'subtle' },
  interrupted: { icon: ICONS.interrupted, color: 'subtle' },
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
  { value: 'diff', icon: ICONS.diff, label: 'Cambios' },
  { value: 'history', icon: ICONS.history, label: 'Historial' },
]

const SCOPE_LABELS: { value: CambiosScope; icon: string; label: string }[] = [
  { value: 'commits', icon: ICONS.commit, label: 'Commits' },
  { value: 'uncommitted', icon: ICONS.uncommitted, label: 'Sin commitear' },
  { value: 'branch', icon: ICONS.branch, label: 'Rama' },
]

const span = (value: string, style: Omit<Span, 'text'> = {}): Span => ({ text: value, ...style })

const touches = (change: FileChange, edited: string[]): boolean =>
  edited.some(path => path === change.path || path.endsWith(`/${change.path}`))

/** The main loop's view lists every session commit; an agent's, its own. */
export const commitsFor = (list: CommitRecord[], scope: string): CommitRecord[] =>
  scope === MAIN ? list : list.filter(one => (one.agentId ?? MAIN) === scope)

/** Which loop made each session commit, by its first seven hex digits; the caller checks the full sha. */
export const sessionOwners = (list: CommitRecord[]): Map<string, CommitRecord[]> => {
  const owners = new Map<string, CommitRecord[]>()
  for (const commit of list) owners.set(commit.sha.slice(0, 7), [...(owners.get(commit.sha.slice(0, 7)) ?? []), commit])
  return owners
}

export const ownerOf = (owners: Map<string, CommitRecord[]>, sha: string): CommitRecord | undefined =>
  owners.get(sha.slice(0, 7))?.find(one => sameSha(one.sha, sha))

export const cambiosScopeOf = (snap: Pick<Snapshot, 'scopeByAgent' | 'commitList'>, scope: string): CambiosScope =>
  snap.scopeByAgent[scope] ?? (commitsFor(snap.commitList, scope).length > 0 ? 'commits' : 'uncommitted')

export const buildPane = (snap: Snapshot, width: number): PaneModel => {
  const { list, flipped, opened, patches, records } = snap
  const accent = snap.accent
  const scope = defaultAgent(records, snap.picked)
  const current: Tab = snap.tabByAgent[scope] ?? 'summary'
  const cambios = cambiosScopeOf(snap, scope)
  const agent = records.find(one => one.id === scope)
  const scoped = list.filter(one => (one.agentId ?? MAIN) === scope)
  const commands = scoped.filter(one => one.command !== undefined)
  const lastCommand = commands.at(-1)
  const edited = distinct(scoped.filter(one => CHANGE_TOOLS.has(one.tool)).map(one => one.file))
  const sessionEdited = distinct(list.filter(one => CHANGE_TOOLS.has(one.tool)).map(one => one.file))
  const visibleFiles = snap.files.filter(change => !change.untracked || touches(change, sessionEdited))
  const hiddenUntracked = snap.files.length - visibleFiles.length
  const scopedFiles = scope === MAIN ? visibleFiles : visibleFiles.filter(change => touches(change, edited))
  const waiting = list.some(one => one.tool === 'AskUserQuestion' && one.status === 'running')

  const isOpen = (key: string, byDefault: boolean): boolean => byDefault !== flipped.includes(key)
  const line = (key: string, value: string, style: Omit<Span, 'text'> = {}): Row => ({ key, cells: [{ spans: [span(fit(value, width), style)] }] })
  const blank = (key: string): Row => line(key, ' ')
  const divider = (key: string): Row => line(key, '─'.repeat(width), { dim: true })
  const agentTag = (agentId: string | undefined): string => {
    if (agentId === undefined) return ''
    const record = records.find(one => one.id === agentId)
    return ` · ${record ? shortName(record) : 'agente'}`
  }
  const toggleRow = (key: string, label: string, open: boolean, indent = ''): Row => ({
    key,
    cells: [{ spans: [span(fit(`${indent}${open ? '▼' : '▶'} ${label}`, width))], action: { kind: 'toggle', key }, label, key: `btn-${key}` }],
  })
  const section = (key: string, label: string, byDefault: boolean, body: () => Row[]): Row[] => {
    const open = isOpen(key, byDefault)
    return [toggleRow(key, label, open), ...(open ? body() : [])]
  }

  const stepRows = (steps: Step[]): Row[] =>
    steps.flatMap(step => {
      const look = STATUS_LOOK[step.status]
      const right = step.status === 'running' ? '…' : seconds(step.durationMs)
      return [
        {
          key: `step-${step.key}`,
          cells: [{ spans: [span(`${look.icon} `, { color: look.color }), span(`${KIND_ICONS[step.kind]} ${fit(step.title, width - right.length - 6)}`)] }],
          right: [span(right, { dim: true })],
        },
        ...(step.detail === '' ? [] : [line(`detail-${step.key}`, `    ${step.detail}`, { dim: true })]),
      ]
    })

  const commandRows = (entry: ToolEntry, keyPrefix: string): Row[] => {
    const verdict = verdictOf(entry)
    const summary = resultLine(entry)
    const outputOpen = isOpen(`${keyPrefix}-output`, false)
    const rows: Row[] = [line(`${keyPrefix}-cmd`, `$ ${entry.command ?? ''}`, { color: 'permission' })]
    if (entry.status === 'running') rows.push(line(`${keyPrefix}-running`, `  ${ICONS.running} ejecutando…`, { color: 'warning' }))
    for (const test of entry.testFiles ?? []) {
      rows.push({
        key: `${keyPrefix}-test-${test.file}`,
        cells: [{ spans: [span('  '), span(`${test.ok ? ICONS.ok : ICONS.error} `, { color: test.ok ? 'success' : 'error' }), span(fit(test.file, width - 6))] }],
      })
    }
    if (entry.status !== 'running') {
      const look = entry.status === 'interrupted' ? STATUS_LOOK.interrupted : verdict === 'FAIL' || entry.status !== 'ok' ? STATUS_LOOK.error : STATUS_LOOK.ok
      const label = entry.status === 'interrupted' ? ' interrumpido' : verdict ? ` ${verdict}` : ''
      const tail = `${summary}${summary && entry.durationMs !== undefined ? ' · ' : ''}${seconds(entry.durationMs)}`
      rows.push({
        key: `${keyPrefix}-verdict`,
        cells: [{ spans: [span(`${look.icon}${label}`, { color: look.color, bold: true }), span(` ${fit(tail, width - 16)}`, { dim: true })] }],
      })
    }
    if (entry.output !== '') {
      rows.push(toggleRow(`${keyPrefix}-output`, outputOpen ? 'Ocultar salida' : 'Ver salida completa', outputOpen))
      if (outputOpen) entry.output.split('\n').forEach((out, index) => rows.push(line(`${keyPrefix}-out-${index}`, `  ${out}`, { dim: true })))
    }
    return rows
  }

  const historyRows = (): Row[] =>
    commands
      .slice()
      .reverse()
      .map(entry => {
        const look = STATUS_LOOK[entry.status]
        const right = entry.status === 'running' ? '…' : `exit ${entry.exitCode ?? '?'} · ${seconds(entry.durationMs)}`
        return {
          key: `hist-${entry.id}`,
          cells: [{ spans: [span('  '), span(`${look.icon} `, { color: look.color }), span(fit(entry.command ?? '', width - right.length - 7))] }],
          right: [span(right, { dim: true })],
        }
      })

  const fileRows = (target: DiffTarget, file: FileChange, indent: string): Row[] => {
    const key = targetKey(target)
    const isOpenFile = opened.includes(key)
    const shown = clean(file.path)
    const counts = file.binary ? 'bin' : `+${file.added} −${file.removed}`
    const mark = file.untracked ? ' nuevo' : ''
    const rows: Row[] = [
      {
        key: `file-${key}`,
        cells: [
          { spans: [span(`${indent}${isOpenFile ? '▾' : '▸'} `)], action: { kind: 'diff', target }, label: isOpenFile ? 'Ocultar diff' : 'Ver diff aquí', key: `fold-${key}` },
          {
            spans: [span(`${fileIcon(file.path)} ${fit(shown, width - counts.length - mark.length - indent.length - 7)}`), ...(mark ? [span(mark, { color: 'success', dim: true })] : [])],
            action: { kind: 'open', target },
            label: `Abrir ${shown} en nvim`,
            key: `open-${key}`,
          },
        ],
        right: file.binary ? [span('bin', { dim: true })] : [span(`+${file.added}`, { color: 'success' }), span(' '), span(`−${file.removed}`, { color: 'error' })],
      },
    ]
    if (!isOpenFile) return rows
    const patch = patches[key]
    if (patch === undefined) return [...rows, line(`loading-${key}`, `${indent}  Cargando diff…`, { dim: true })]
    if (patch.rows.length === 0) return [...rows, line(`nodiff-${key}`, `${indent}  Sin diferencias.`, { dim: true })]
    const gutter = Math.max(3, ...patch.rows.map(row => row.gutter.length))
    patch.rows.forEach((row, index) =>
      rows.push(
        row.kind === 'hunk'
          ? line(`hunk-${key}-${index}`, `${indent}  ${ICONS.hunk} ${row.text}`, { color: 'suggestion' })
          : {
              key: `row-${key}-${index}`,
              cells: [{
                spans: [
                  span(`${indent}  ${row.gutter.padStart(gutter)} │`, { dim: true }),
                  span(`${row.sign} ${fit(row.text, width - gutter - indent.length - 8)}`, { color: row.kind === 'add' ? 'diffAdded' : row.kind === 'del' ? 'diffRemoved' : undefined }),
                ],
              }],
            },
      ),
    )
    if (patch.total > patch.rows.length) rows.push(line(`more-${key}`, `${indent}  … ${patch.total - patch.rows.length} líneas más`, { dim: true }))
    return rows
  }

  const uncommittedRows = (): Row[] => {
    const hidden = scope === MAIN && hiddenUntracked > 0
      ? [line('hidden-untracked', `${hiddenUntracked} archivos sin seguimiento de antes de la sesión, ocultos`, { dim: true })]
      : []
    if (scopedFiles.length === 0) return [line('no-changes', scope === MAIN ? 'Sin cambios sin commitear.' : 'Este agente no tiene cambios sin commitear.', { dim: true }), ...hidden]
    return [...scopedFiles.flatMap(file => fileRows({ scope: 'uncommitted', path: file.path, ...(file.untracked ? { untracked: true } : {}) }, file, '')), ...hidden]
  }

  const commitRows = (): Row[] => {
    const own = commitsFor(snap.commitList, scope).slice().reverse()
    const rows: Row[] = []
    if (own.length === 0) rows.push(line('no-commits', scope === MAIN ? 'Sin commits en esta sesión todavía.' : 'Este agente no ha hecho commits.', { dim: true }))
    for (const commit of own) {
      const key = `commit-${commit.sha}`
      const open = isOpen(key, false)
      const totals = commit.added === undefined ? (commit.statsFailed ? '?' : '…') : `+${commit.added} −${commit.removed ?? 0}`
      const tag = scope === MAIN ? agentTag(commit.agentId) : ''
      rows.push({
        key,
        cells: [
          { spans: [span(`${open ? '▾' : '▸'} `)], action: { kind: 'toggle', key }, label: open ? 'Ocultar archivos' : 'Ver archivos', key: `btn-${key}` },
          {
            spans: [
              span(`${commit.isMerge ? ICONS.merge : ICONS.commit} `, { color: accent }),
              span(`${commit.sha.slice(0, 7)} `, { color: 'warning' }),
              span(fit(commit.subject, width - totals.length - tag.length - 14)),
              ...(tag ? [span(tag, { color: accent, dim: true })] : []),
            ],
          },
        ],
        right: commit.added === undefined ? [span(totals, { dim: true })] : [span(`+${commit.added}`, { color: 'success' }), span(' '), span(`−${commit.removed ?? 0}`, { color: 'error' })],
      })
      if (!open) continue
      rows.push(line(`${key}-meta`, `    ${ICONS.branch} ${commit.branch}`, { dim: true }))
      if (commit.files === undefined) rows.push(line(`${key}-loading`, commit.statsFailed ? '    No se pudo leer el commit.' : '    Cargando archivos…', { dim: true }))
      else commit.files.forEach(file => rows.push(...fileRows({ scope: 'commit', sha: commit.sha, path: file.path }, file, '  ')))
    }
    return rows
  }

  const historyTabRows = (): Row[] => {
    const view = snap.historyView
    if (view.state === 'error') return [line('hist-error', view.error ?? 'git falló.', { color: 'warning' })]
    if (view.rows.length === 0) return [line('hist-loading', view.state === 'ready' ? 'Sin commits todavía.' : 'Cargando historial…', { dim: true })]
    const owners = sessionOwners(snap.commitList)
    const shown = view.rows.filter(row => row.sha !== undefined).length
    const ours = view.rows.filter(row => row.sha !== undefined && ownerOf(owners, row.sha) !== undefined).length
    const rows: Row[] = [{
      key: 'hist-legend',
      cells: [{ spans: [span(`${ICONS.history} ${shown} commits · `, { dim: true }), span('●', { color: accent }), span(` ${ours} de esta sesión`, { dim: true }), ...(view.state === 'loading' ? [span(' · actualizando…', { dim: true })] : [])] }],
    }]
    view.rows.forEach((row, index) => {
      const sha = row.sha
      if (sha === undefined) {
        rows.push(line(`hg-${index}`, `  ${row.graph}`, { dim: true }))
        return
      }
      const owner = ownerOf(owners, sha)
      const loop = owner === undefined ? undefined : (owner.agentId ?? MAIN)
      const strength = loop === undefined ? 'none' : scope === MAIN || loop === scope ? 'strong' : 'soft'
      const mark: Omit<Span, 'text'> = strength === 'strong' ? { color: accent } : strength === 'soft' ? { color: accent, dim: true } : {}
      const key = `hist-${sha}`
      const open = isOpen(key, false)
      const right = [ago(row.at, view.loadedAt), fit(row.author ?? '', 14)].filter(Boolean).join(' · ')
      const tag = owner !== undefined && scope === MAIN ? agentTag(owner.agentId) : ''
      const refSpans = (row.refs ?? []).flatMap((ref, at): Span[] => {
        const isHead = ref === 'HEAD' || ref.startsWith('HEAD -> ')
        return [span(at === 0 ? '(' : ', ', { color: 'suggestion', dim: true }), span(ref, { color: 'suggestion', bold: isHead })]
      })
      const refsText = refSpans.length > 0 ? refSpans.map(one => one.text).join('').length + 2 : 0
      const used = 2 + row.graph.length + sha.length + 1 + refsText + tag.length + right.length + 2
      rows.push({
        key,
        cells: [{
          spans: [
            span(strength === 'none' ? '  ' : '● ', { ...mark, bold: strength === 'strong' }),
            span(row.graph, { dim: true }),
            span(`${sha} `, strength === 'none' ? { color: 'warning' } : { ...mark, bold: strength === 'strong' }),
            ...refSpans,
            ...(refSpans.length > 0 ? [span(') ', { color: 'suggestion', dim: true })] : []),
            span(fit(row.subject ?? '', width - used), mark),
            ...(tag ? [span(tag, { color: accent, dim: true })] : []),
          ],
          action: { kind: 'commit', sha },
          label: open ? 'Ocultar archivos' : 'Ver archivos',
          key: `btn-${key}`,
        }],
        right: [span(right, { dim: true })],
      })
      if (!open) return
      const files = owner?.files ?? snap.historyFiles[sha]?.files
      const failed = owner?.statsFailed === true || snap.historyFiles[sha]?.failed === true
      if (files === undefined) rows.push(line(`${key}-loading`, failed ? '    No se pudo leer el commit.' : '    Cargando archivos…', { dim: true }))
      else if (files.length === 0) rows.push(line(`${key}-empty`, '    El commit no cambia archivos.', { dim: true }))
      else files.forEach(file => rows.push(...fileRows({ scope: 'commit', sha: owner?.sha ?? sha, path: file.path }, file, '    ')))
    })
    if (view.more > 0) rows.push(line('hist-more', `… ${view.more} más`, { dim: true }))
    return rows
  }

  const branchRows = (): Row[] => {
    const view = snap.branchView
    if (!view.isLoaded) return [line('branch-loading', 'Cargando la rama…', { dim: true })]
    if (view.error !== undefined) return [line('branch-error', view.error, { color: 'warning' })]
    return [
      line('branch-base', `${ICONS.branch} vs ${view.baseRef ?? ''} (${(view.base ?? '').slice(0, 7)}) · ${view.commits.length} commits · ${view.files.length} archivos`, { dim: true }),
      ...section('branch-commits', `Commits de la rama · ${view.commits.length}`, true, () =>
        view.commits.map(commit => ({
          key: `bc-${commit.sha}`,
          cells: [{ spans: [span(`  ${ICONS.commit} `, { color: accent }), span(`${commit.sha} `, { color: 'warning' }), span(fit(commit.subject, width - commit.sha.length - 6))] }],
        })),
      ),
      ...(view.files.length === 0 ? [line('branch-nofiles', 'La rama no cambia archivos.', { dim: true })] : view.files.flatMap(file => fileRows({ scope: 'branch', sha: view.base, path: file.path }, file, ''))),
    ]
  }

  const cambiosRows = (): Row[] => (cambios === 'commits' ? commitRows() : cambios === 'branch' ? branchRows() : uncommittedRows())

  const decisions = scoped.flatMap(one => one.decisions ?? [])
  const readFiles = distinct(scoped.filter(one => one.tool === 'Read').map(one => one.file)).reverse()
  const usage = scopedContext(snap, scope)
  const percent = contextPercentOf(usage)
  const contextRow = (key: string, indent: string): Row => {
    const label = contextLabel(usage)
    const hint = scope === MAIN ? ' de la última respuesta' : ' de la última respuesta de este agente'
    const used = indent.length + 2 + 11 + label.length
    return {
      key,
      cells: [{
        spans: [
          span(`${indent}${ICONS.gauge} `),
          span(`${contextBar(percent)} `, { color: contextTone(percent) }),
          span(fit(label, width - indent.length - 13)),
          ...(usage.tokens !== undefined && used + hint.length <= width ? [span(hint, { dim: true })] : []),
        ],
      }],
    }
  }

  const summaryRows = (): Row[] => {
    const steps = groupSteps(scoped)
    if (steps.length === 0) return [line('empty', 'Sin actividad todavía.', { dim: true })]
    return [
      ...stepRows(steps),
      ...(lastCommand ? [blank('gap-last'), ...section(`last-cmd-${scope}`, 'Último comando', true, () => commandRows(lastCommand, `last-${scope}`))] : []),
      blank('gap-changes'),
      divider('div-changes'),
      line('changes-title', `${ICONS.uncommitted} SIN COMMITEAR`, { bold: true }),
      ...uncommittedRows(),
      blank('gap-sections'),
      ...section(`decisions-${scope}`, `${ICONS.decision} Decisiones técnicas · ${decisions.length}`, false, () =>
        decisions.length === 0
          ? [line('no-decisions', '  Sin preguntas todavía.', { dim: true })]
          : decisions.flatMap((one, index) => [
              line(`q-${index}`, `  ${ICONS.question} ${one.question}`),
              line(`a-${index}`, `    → ${one.answer || 'pendiente'}`, { color: one.refused ? 'error' : one.answer ? 'success' : 'warning' }),
            ]),
      ),
      ...section(`history-${scope}`, `${ICONS.log} ${scope === MAIN ? 'Historial de comandos' : 'Historial de este agente'} · ${commands.length}`, false, historyRows),
      ...section(`context-${scope}`, `${ICONS.brain} Contexto consultado`, false, () => [
        contextRow('ctx-usage', '  '),
        ...readFiles.slice(0, 30).map(path => line(`ctx-${path}`, `  ${fileIcon(path)} ${path}`)),
      ]),
    ]
  }

  const commandsTabRows = (): Row[] => {
    if (!lastCommand) return [line('no-commands', 'Sin comandos todavía.', { dim: true })]
    return [
      line('last-title', `${ICONS.command} Último comando`, { bold: true }),
      ...commandRows(lastCommand, `cmdtab-${scope}`),
      blank('gap-history'),
      line('history-title', `${ICONS.log} Historial · ${commands.length}`, { bold: true }),
      ...historyRows(),
    ]
  }

  const body = current === 'diff' ? cambiosRows() : current === 'commands' ? commandsTabRows() : current === 'history' ? historyTabRows() : summaryRows()

  const status = waiting
    ? span(`${ICONS.waiting} esperando respuesta`, { color: 'warning' })
    : snap.isWorking
      ? span(`${ICONS.running} ejecutando`, { color: 'warning' })
      : undefined

  const chip = (key: string, label: string, isOn: boolean, action: Action, look?: Look): Cell => ({
    key,
    label,
    action,
    spans: [span(` ${label}${look ? ' ' : ' '}`, { inverse: isOn, bold: isOn }), ...(look ? [span(`${look.icon} `, { color: look.color, inverse: isOn })] : []), span(' ')],
  })

  const header: Row[] = [{ key: 'title', cells: [{ spans: [span('ACTIVIDAD', { bold: true })] }], right: status ? [status] : [] }]
  if (records.length > 0) {
    header.push({
      key: 'agents',
      cells: [
        chip(`agent-${MAIN}`, 'Principal', scope === MAIN, { kind: 'agent', id: MAIN }),
        ...records.map(one => chip(`agent-${one.id}`, shortName(one), scope === one.id, { kind: 'agent', id: one.id }, AGENT_LOOK[one.state])),
      ],
    })
  }
  if (agent) {
    const look = AGENT_LOOK[agent.state]
    header.push(
      { key: 'agent-head', cells: [{ spans: [span(`${ICONS.agent} ${shortName(agent)}`, { color: accent, bold: true }), span(` · ${agent.id.slice(0, 4)} · `, { dim: true }), span(look.label, { color: look.color })] }] },
      line('agent-task', agent.description, { dim: true }),
    )
  }
  header.push({
    key: 'tabs',
    cells: TAB_LABELS.map(tab => ({
      key: `tab-${tab.value}`,
      label: tab.label,
      action: { kind: 'tab', tab: tab.value } as Action,
      spans: [span(` ${tab.icon} ${tab.label} `, { inverse: current === tab.value, bold: current === tab.value, color: current === tab.value ? 'claude' : undefined }), span(' ')],
    })),
  })
  if (current === 'diff') {
    const counts: Record<CambiosScope, string> = {
      commits: String(commitsFor(snap.commitList, scope).length),
      uncommitted: String(scopedFiles.length),
      branch: snap.branchView.isLoaded && snap.branchView.error === undefined ? String(snap.branchView.commits.length) : '',
    }
    header.push({
      key: 'scopes',
      cells: SCOPE_LABELS.map(one => ({
        key: `scope-${one.value}`,
        label: one.label,
        action: { kind: 'scope', scope: one.value } as Action,
        spans: [
          span(` ${one.icon} ${one.label}${counts[one.value] ? ` ${counts[one.value]}` : ''} `, { inverse: cambios === one.value, bold: cambios === one.value, color: cambios === one.value ? 'suggestion' : undefined }),
          span(' '),
        ],
      })),
    })
  }
  header.push(divider('div-head'))

  const wall = wallTime(scoped.filter(one => one.durationMs !== undefined))
  const footer: Row[] = [
    divider('div-foot'),
    line(
      'footer',
      `${ICONS.files} ${scopedFiles.length} archivos · ${ICONS.command} ${commands.length} comandos · ${ICONS.time} ${seconds(wall) || '0.0 s'} · ${ICONS.cost} ${dollars(snap.usd)} sesión`,
      { dim: true },
    ),
    contextRow('footer-context', ''),
  ]

  return { header, body, footer, scope, cambios, tab: current }
}

export type PaneFrame = { rows: Row[]; isWindowed: boolean; total: number; room: number }

/**
 * Fixes the header and footer and windows the body between them. When the
 * frame is too short for even one body row, the tree goes whole and the
 * engine scrolls it.
 */
export const paneFrame = (model: PaneModel, bodyRows: number, view: PaneScroll, isDock: boolean): PaneFrame => {
  const total = model.body.length
  const footer = bodyRows >= model.header.length + model.footer.length + 1 ? model.footer : []
  const room = bodyRows - model.header.length - footer.length
  if (room < 1) return { rows: [...model.header, ...model.body, ...model.footer], isWindowed: false, total, room: 0 }
  const start = windowStart(view, total, room)
  const visible = model.body.slice(start, start + room)
  const [title, ...rest] = model.header
  const indicator = total > room ? [span(`  ↕ ${start + 1}-${start + visible.length}/${total}`, { dim: true })] : []
  const header = title ? [{ ...title, right: [...(title.right ?? []), ...indicator] }, ...rest] : rest
  const padding = isDock ? Array.from({ length: room - visible.length }, (_, index): Row => ({ key: `pad-${index}`, cells: [{ spans: [span(' ')] }] })) : []
  return { rows: [...header, ...visible, ...padding, ...footer], isWindowed: true, total, room }
}

// ---------------------------------------------------------------- hooks

const runOf = ($: Api): Run => (argv, init) => $.process.run(argv, init)

const readSnapshot = async ($: Api): Promise<Snapshot> => {
  const [list, tabByAgent, flipped, files, usd, context, opened, patches, records, picked, isWorking, view, commitList, scopeByAgent, branchView, steps, historyView, historyFilesBySha, accent] = await Promise.all([
    read($, entries), read($, tabs), read($, toggled), read($, changes), read($, costUsd), read($, contextUsage), read($, openFiles), read($, diffs),
    read($, agents), read($, pickedAgent), read($, working), read($, scroll), read($, commits), read($, scopes), read($, branch), read($, stepContext),
    read($, history), read($, historyFiles), read($, accentColor),
  ])
  return { accent, list, tabByAgent, flipped, files, usd, context, steps, opened, patches, records, picked, isWorking, commitList, scopeByAgent, branchView, view, historyView, historyFiles: historyFilesBySha }
}

/** Fills in the line counts and files of up to ten commits that have none yet. */
const fillCommitStats = async ($: Api, run: Run, top: string): Promise<void> => {
  const pending = (await read($, commits)).filter(one => one.added === undefined && !one.statsFailed).slice(0, 10)
  for (const commit of pending) {
    const stats = await loadCommitStats(run, top, commit.sha)
    await update($, commits, list =>
      list.map(one => (one.sha !== commit.sha ? one : stats ? { ...one, added: stats.added, removed: stats.removed, files: stats.files, isMerge: stats.isMerge } : { ...one, statsFailed: true })),
    )
  }
}

/** One history load at a time; a request while one runs joins it. */
const reloadHistory = ($: Api): Promise<void> => {
  historyLoading ??= (async () => {
    await update($, history, (view): HistoryView => ({ ...view, state: 'loading' }))
    const loaded = await loadHistory(runOf($), await $.clock.now())
    await update($, history, () => loaded)
  })()
    .catch(() => undefined)
    .finally(() => {
      historyLoading = undefined
    })
  return historyLoading
}

const rescanOnce = async ($: Api): Promise<void> => {
  const [start, calls] = await Promise.all([read($, sessionStart), read($, commitCalls)])
  if (start <= 0) return
  const run = runOf($)
  const scan = await scanSessionCommits(run, start, calls)
  if (scan === undefined) return
  if (scan.commits.length > 0) await update($, commits, list => mergeScanned(list, scan.commits))
  await fillCommitStats($, run, scan.repo)
  if ((await read($, history)).state !== 'idle') await reloadHistory($)
}

/** Asks git for the session's commits shortly after a trigger; one rescan in flight, at most one queued. */
const scheduleRescan = ($: Api): void => {
  rescanTimer?.cancel()
  rescanTimer = $.clock.after(RESCAN_MS, () => {
    rescanTimer = undefined
    if (scanning !== undefined) {
      scanAgain = true
      return
    }
    scanning = (async () => {
      do {
        scanAgain = false
        await rescanOnce($)
      } while (scanAgain)
    })()
      .catch(() => undefined)
      .finally(() => {
        scanning = undefined
      })
  })
}

/** The session's start: stored once; a mod loaded mid-session reaches back to what it already recorded. */
export const sessionStartOf = (stored: number, now: number, list: ToolEntry[], known: CommitRecord[]): number =>
  stored > 0 ? stored : Math.min(now, ...list.map(one => one.startedAt), ...known.map(one => one.at))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'activity', description: 'Abre el panel de actividad' })
    const [stored, list, known] = await Promise.all([read($, sessionStart), read($, entries), read($, commits)])
    const now = await $.clock.now()
    await update($, sessionStart, () => sessionStartOf(stored, now, list, known))
    scheduleRescan($ as Api)
    void refreshAccent($ as Api).catch(() => undefined)
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, autoOpen, () => false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('cost') && e.cost !== undefined) await update($, costUsd, () => e.cost?.usd ?? 0)
    if (e.changed.includes('context')) {
      const usage: ContextUsage = { window: e.context.window }
      if (e.context.tokens !== undefined) usage.tokens = e.context.tokens
      if (e.context.percent !== undefined) usage.percent = e.context.percent
      await update($, contextUsage, () => usage)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const used = result?.usage
    if (used) {
      const tokens = used.input_tokens + used.cache_creation_input_tokens + used.cache_read_input_tokens
      await update($, stepContext, all => ({ ...all, [e.agentId ?? MAIN]: { tokens, model: used.model } })).catch(() => undefined)
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    const loopId = e.agentId
    if (loopId === undefined) await update($, working, () => true)
    else await update($, agents, list => setAgentState(list, loopId, 'running'))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const loopId = e.agentId
    if (loopId === undefined) await update($, working, () => false)
    else await update($, agents, list => setAgentState(list, loopId, turnEndState(e.reason)))
    scheduleRescan($)
    void refreshAccent($).catch(() => undefined)
    return done
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId !== undefined) {
      const record: AgentRecord = {
        id: spawned.agentId,
        description: oneLine(e.description ?? ''),
        type: oneLine(e.subagentType ?? 'agente'),
        state: 'running',
        startedAt: await $.clock.now(),
      }
      await update($, agents, list => mergeAgent(list, record))
    }
    return spawned
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.viewport?.isFullscreen === true && !autoOpenSent && (await read($, autoOpen))) {
      autoOpenSent = true
      void $.ui.open(PANE_ARGS).catch(() => undefined)
    }
    const usd = await read($, costUsd)
    if (usd <= 0) return next(e)
    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix} · ${dollars(usd)}` } })
  })

  on('command.run', { command: 'activity' }, async $ => {
    const opened = await $.ui.open(PANE_ARGS).catch(() => undefined)
    return { text: opened?.isPlaced === false ? 'El panel de actividad espera a que haya espacio.' : 'Panel de actividad abierto.' }
  })

  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const snap = await readSnapshot($ as Api)
    const view = snap.view
    const frame = paneFrame(buildPane(snap, 80), e.bodyRows, view, false)
    if (!frame.isWindowed) return next(e)
    const isJump = Math.abs(e.by) === e.contentRows && e.contentRows !== e.bodyRows
    await update($, scroll, state => scrolled(state, e.by, frame.total, frame.room, isJump))
    return {}
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const run: Run = (argv, init) => $.process.run(argv, init)
    const startedAt = await $.clock.now()
    const loopId = e.agentId
    const entry: ToolEntry = {
      id: e.tool_use_id,
      tool: e.tool,
      summary: summarize(input),
      status: 'running',
      output: '',
      startedAt,
      ...(loopId === undefined ? {} : { agentId: loopId }),
    }
    if (e.tool === 'Bash') entry.command = cleanText(input.command)
    const file = cleanText(input.file_path) ?? cleanText(input.notebook_path)
    if (file !== undefined) entry.file = file
    if (e.tool === 'Agent') entry.note = cleanText(input.subagent_type)
    if (e.tool === 'AskUserQuestion') entry.decisions = decisionsOf(input)
    await update($, entries, list => [...list, entry].slice(-KEEP))

    if (loopId !== undefined && !(await read($, agents)).some(one => one.id === loopId)) {
      const info = (await $.agent.list().catch(() => [])).find(one => one.id === loopId)
      if (info) {
        const record: AgentRecord = { id: loopId, description: oneLine(info.description), type: oneLine(info.type), state: agentStateOf(info.status), startedAt }
        if (info.name) record.name = oneLine(info.name)
        await update($, agents, list => mergeAgent(list, record))
      }
    }

    const finish = async (finished: Partial<ToolEntry>) => {
      const durationMs = (await $.clock.now()) - startedAt
      await update($, entries, list => list.map(one => (one.id === entry.id ? { ...one, durationMs, ...finished } : one)))
    }

    let ran: Awaited<ReturnType<typeof next>> | undefined
    try {
      ran = await next(e)
    } finally {
      if (ran === undefined) await finish({ status: 'interrupted', output: 'interrumpido' }).catch(() => undefined)
    }

    const wasInterrupted = (ran.result as { interrupted?: unknown } | undefined)?.interrupted === true
    const status: CallStatus = ran.deny !== undefined ? 'denied' : wasInterrupted ? 'interrupted' : ran.isError === true ? 'error' : 'ok'
    const full = ran.deny ?? ran.text ?? ''
    const finished: Partial<ToolEntry> = { status, output: lastLines(full, OUTPUT_LINES) }
    if (entry.command !== undefined) {
      const exitCode = exitCodeOf(full, ran.isError === true)
      if (exitCode !== undefined) finished.exitCode = exitCode
      if (isTestCommand(entry.command)) finished.testFiles = testFilesOf(full)
    }
    if (e.tool === 'AskUserQuestion') finished.decisions = answered(input, status, ran.result)
    const spawnedId = text((ran.result as { agentId?: unknown } | undefined)?.agentId)
    if (e.tool === 'Agent' && spawnedId !== undefined) {
      finished.spawned = spawnedId
      const state = agentResultState(status, ran.result)
      const known = (await read($, agents)).some(one => one.id === spawnedId) || (await $.agent.list().catch(() => [])).some(one => one.id === spawnedId)
      if (state !== undefined && known) {
        const record: AgentRecord = { id: spawnedId, description: cleanText(input.description) ?? '', type: entry.note ?? 'agente', state, startedAt }
        await update($, agents, list => mergeAgent(list, record))
      }
    }
    await finish(finished)

    const rawCommand = text(input.command)
    if (e.tool === 'Bash' && status !== 'denied' && rawCommand !== undefined && gitCommitVerbs(rawCommand).length > 0) {
      const endedAt = await $.clock.now()
      const dir = commitDirOf(rawCommand)
      const top = dir === undefined || !SAFE_PATH.test(dir) ? undefined : await gitTop(run, dir)
      const call: CommitCall = { startedAt, endedAt, ...(loopId === undefined ? {} : { agentId: loopId }), ...(top === undefined ? {} : { top }) }
      await update($, commitCalls, list => [...list, call].slice(-COMMIT_CALLS))
      scheduleRescan($ as Api)
    }
    if (e.tool === 'Bash' && status === 'ok' && rawCommand !== undefined && ran.text !== undefined) {
      const found = commitsIn(rawCommand, ran.text)
      if (found.length > 0) await update($, commits, list => addCommits(list, found, loopId, startedAt))
      if (madeMergeCommit(rawCommand, ran.text)) {
        void (async () => {
          const top = await gitTop(run)
          const head = top === undefined ? undefined : await loadHeadCommit(run, top)
          if (head) await update($, commits, list => addCommits(list, [head], loopId, startedAt))
        })().catch(() => undefined)
      }
    }

    const refresh = async () => {
      const top = await gitTop(run)
      if (top === undefined) return
      const fileList = await loadUncommitted(run, top, async path => {
        const info = await $.fs.stat(path)
        return info.isLink || info.kind !== 'file' || info.size > 2_000_000 ? Promise.reject(new Error('skipped')) : $.fs.read(path)
      })
      if (fileList !== undefined) await update($, changes, () => fileList)

      for (const key of await read($, openFiles)) {
        if (!key.startsWith('u:') && !key.startsWith('b:')) continue
        const path = key.slice(2)
        const change = key.startsWith('u:') ? fileList?.find(one => one.path === path) : undefined
        if (key.startsWith('u:') && change === undefined) {
          await update($, openFiles, keys => keys.filter(one => one !== key))
          await update($, diffs, all => Object.fromEntries(Object.entries(all).filter(([name]) => name !== key)))
          continue
        }
        const target: DiffTarget = key.startsWith('u:')
          ? { scope: 'uncommitted', path, ...(change?.untracked ? { untracked: true } : {}) }
          : { scope: 'branch', path, sha: (await read($, branch)).base }
        const patch = await fetchDiff(run, top, target)
        await update($, diffs, all => ({ ...all, [key]: patch }))
      }

      await fillCommitStats($ as Api, run, top)

      if ((await read($, branch)).isLoaded) {
        const view = await loadBranch(run, top)
        await update($, branch, () => view)
      }
    }

    const touchesFiles = (e.tool === 'Bash' && ran.isReadOnly !== true) || CHANGE_TOOLS.has(e.tool)
    if (touchesFiles) {
      refreshTimer?.cancel()
      refreshTimer = $.clock.after(REFRESH_MS, () => {
        refreshTimer = undefined
        void refresh().catch(() => undefined)
      })
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.isExpanded === true) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const summary = summarize((e.props.input ?? {}) as Record<string, unknown>)
    if (e.props.isInterrupted) {
      return <Text dimColor wrap="truncate-end">{ICONS.interrupted} interrumpido: {e.props.tool} {summary}</Text>
    }
    if (!e.props.isErrored) return <Box />
    return (
      <Text color="error" wrap="truncate-end">
        {ICONS.error} {e.props.tool} falló: {summary}
      </Text>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.isExpanded === true) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const notable = e.props.calls.filter(call => call.isErrored || call.isInterrupted)
    if (notable.length === 0) return <Box />
    return (
      <Box flexDirection="column">
        {notable.map(call => {
          const summary = summarize((call.input ?? {}) as Record<string, unknown>)
          return call.isErrored ? (
            <Text color="error" wrap="truncate-end">{ICONS.error} {call.tool} falló: {summary}</Text>
          ) : (
            <Text dimColor wrap="truncate-end">{ICONS.interrupted} interrumpido: {call.tool} {summary}</Text>
          )
        })}
      </Box>
    )
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
    const snap = await readSnapshot($ as Api)
    const view = snap.view
    const width = Math.max(1, e.props.bodyColumns)
    const model = buildPane(snap, width)
    const frame = paneFrame(model, e.props.scroll.bodyRows, view, e.props.placement === 'dock')
    const run: Run = (argv, init) => $.process.run(argv, init)
    if (model.tab === 'history' && snap.historyView.state === 'idle') void reloadHistory($ as Api)

    const resetScroll = () => update($, scroll, () => ({ offset: 0, follow: false }))
    const toggleDiff = async (target: DiffTarget) => {
      const key = targetKey(target)
      let isOpening = false
      const keys = await update($, openFiles, current => {
        isOpening = !current.includes(key)
        return isOpening ? [...current, key].slice(-OPEN_DIFFS) : current.filter(one => one !== key)
      })
      if (!isOpening) {
        await update($, diffs, all => Object.fromEntries(Object.entries(all).filter(([name]) => name !== key)))
        return
      }
      const top = await gitTop(run)
      const patch = top === undefined ? { rows: [], total: 0 } : await fetchDiff(run, top, target)
      await update($, diffs, all => ({ ...Object.fromEntries(Object.entries(all).filter(([name]) => keys.includes(name))), [key]: patch }))
    }
    const toggleCommit = async (sha: string) => {
      const key = `hist-${sha}`
      let isOpening = false
      await update($, toggled, keys => {
        isOpening = !keys.includes(key)
        return isOpening ? [...keys, key].slice(-200) : keys.filter(one => one !== key)
      })
      const known = ownerOf(sessionOwners(await read($, commits)), sha)
      if (!isOpening || known?.files !== undefined || (await read($, historyFiles))[sha]?.files !== undefined) return
      const top = await gitTop(run)
      const stats = top === undefined ? undefined : await loadCommitStats(run, top, sha)
      const loaded: HistoryFiles = stats ? { files: stats.files } : { failed: true }
      await update($, historyFiles, all => Object.fromEntries([...Object.entries(all).filter(([name]) => name !== sha), [sha, loaded]].slice(-HISTORY_FILES)))
    }
    const openTarget = async (target: DiffTarget) => {
      const top = await gitTop(run)
      if (top === undefined) {
        $.ui.toast('No hay repositorio git aquí.')
        return
      }
      const outcome = await openInEditor(run, path => $.fs.exists(path), { top, path: target.path, base: editorBase(target), editor: await read($, editor) })
      const kept = outcome.editor
      if (kept) await update($, editor, () => kept)
      if (!outcome.ok) $.ui.toast(outcome.message ?? 'No se pudo abrir el editor.')
    }
    const act = async (action: Action) => {
      if (action.kind === 'toggle') {
        await update($, toggled, keys => (keys.includes(action.key) ? keys.filter(one => one !== action.key) : [...keys, action.key].slice(-200)))
      } else if (action.kind === 'tab') {
        await update($, tabs, all => ({ ...all, [model.scope]: action.tab }))
        await resetScroll()
        if (action.tab === 'history') await reloadHistory($ as Api)
      } else if (action.kind === 'agent') {
        await update($, pickedAgent, () => action.id)
        await resetScroll()
      } else if (action.kind === 'scope') {
        await update($, scopes, all => ({ ...all, [model.scope]: action.scope }))
        await resetScroll()
        if (action.scope === 'branch') {
          const top = await gitTop(run)
          const loaded: BranchView = top === undefined ? { isLoaded: true, files: [], commits: [], error: 'No hay repositorio git aquí.' } : await loadBranch(run, top)
          await update($, branch, () => loaded)
        }
      } else if (action.kind === 'commit') {
        await toggleCommit(action.sha)
      } else if (action.kind === 'diff') {
        await toggleDiff(action.target)
      } else {
        await openTarget(action.target)
      }
    }

    const spansOf = (spans: Span[]) =>
      spans.map(one => (
        <Text color={one.color} dimColor={one.dim} bold={one.bold} inverse={one.inverse}>{one.text}</Text>
      ))
    const cellOf = (rowKey: string, cell: Cell, index: number) => {
      const action = cell.action
      if (!action) return <Text wrap="truncate-end">{spansOf(cell.spans)}</Text>
      return (
        <Button key={cell.key ?? `${rowKey}-${index}`} plain label={cell.label ?? ''} onPress={() => void act(action).catch(() => undefined)}>
          <Text wrap="truncate-end">{spansOf(cell.spans)}</Text>
        </Button>
      )
    }
    const rowOf = (row: Row) => {
      const hasAction = row.cells.some(cell => cell.action !== undefined)
      const left = hasAction
        ? <Box flexDirection="row">{row.cells.map((cell, index) => cellOf(row.key, cell, index))}</Box>
        : <Text wrap="truncate-end">{row.cells.flatMap(cell => spansOf(cell.spans))}</Text>
      if (row.right === undefined) {
        return hasAction
          ? <Box key={row.key} flexDirection="row" width={width}>{row.cells.map((cell, index) => cellOf(row.key, cell, index))}</Box>
          : <Text key={row.key} wrap="truncate-end">{row.cells.flatMap(cell => spansOf(cell.spans))}</Text>
      }
      return (
        <Box key={row.key} flexDirection="row" justifyContent="space-between" width={width}>
          {left}
          <Text>{spansOf(row.right.length > 0 ? row.right : [span(' ')])}</Text>
        </Box>
      )
    }

    return <Box flexDirection="column" width={width}>{frame.rows.map(rowOf)}</Box>
  })
}
