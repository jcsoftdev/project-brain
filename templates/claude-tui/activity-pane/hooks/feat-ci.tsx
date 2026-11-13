import type { Hook } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Api, Row, Run, Span } from './register'
import { clean, fit, gitTop, span } from './register'
import { notify } from './feat-notify'

export type CiJob = { name: string; status: string; conclusion: string; failedStep?: string }

export type CiRun = {
  id: number
  workflow: string
  title: string
  status: string
  conclusion: string
  branch: string
  createdAt: string
  url: string
  jobs?: CiJob[]
}

export type CiState = 'idle' | 'ready' | 'unavailable'

export type CiView = {
  state: CiState
  reason?: string
  upstream?: string
  ahead?: number
  behind?: number
  sha?: string
  runs: CiRun[]
  checkedAt: number
}

export type CiPart = { view: CiView; now: number }

const EMPTY: CiView = { state: 'idle', runs: [], checkedAt: 0 }

const ciView = atom({ plugin: 'project-brain-activity', key: 'ciStatus' } as const, EMPTY, { shape: 'ci-status-1' })

const PANE_ID = 'activity'
export const ACTIVE_MS = 30_000
export const IDLE_MS = 300_000
const RUN_TIMEOUT_MS = 15_000
const MAX_OUTPUT = 1_000_000
const MAX_RUNS = 5
const MAX_JOBS = 20

// Timers and the in-flight check are not drawn state: a reload restarts them.
let ticker: { cancel: () => void } | undefined
let checking: Promise<void> | undefined
let isDirty = false

// ---------------------------------------------------------------- parsing

const str = (value: unknown): string => (typeof value === 'string' ? clean(value) : '')

const PENDING = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending'])

export const isRunActive = (run: Pick<CiRun, 'status'>): boolean => PENDING.has(run.status)

export const isViewActive = (view: CiView): boolean => view.runs.some(isRunActive)

export const pollEvery = (view: CiView): number => (isViewActive(view) ? ACTIVE_MS : IDLE_MS)

const parseJson = (stdout: string): unknown => {
  if (stdout.length > MAX_OUTPUT) return undefined
  try {
    return JSON.parse(stdout)
  } catch {
    return undefined
  }
}

/** `gh run list --json …`: the newest run of each workflow, newest first. */
export const parseRuns = (stdout: string): CiRun[] => {
  const raw = parseJson(stdout)
  if (!Array.isArray(raw)) return []
  const runs = raw
    .filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null && typeof one.databaseId === 'number')
    .map(
      (one): CiRun => ({
        id: one.databaseId as number,
        workflow: str(one.workflowName) || str(one.name) || 'workflow',
        title: str(one.name),
        status: str(one.status),
        conclusion: str(one.conclusion),
        branch: str(one.headBranch),
        createdAt: str(one.createdAt),
        url: str(one.url),
      }),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const seen = new Set<string>()
  return runs.filter(run => !seen.has(run.workflow) && (seen.add(run.workflow), true)).slice(0, MAX_RUNS)
}

/** `gh run view <id> --json jobs`: each job with the first step that failed. */
export const parseJobs = (stdout: string): CiJob[] | undefined => {
  const raw = parseJson(stdout) as { jobs?: unknown } | undefined
  if (!raw || !Array.isArray(raw.jobs)) return undefined
  return raw.jobs
    .filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null)
    .slice(0, MAX_JOBS)
    .map(one => {
      const steps = Array.isArray(one.steps) ? (one.steps as Record<string, unknown>[]) : []
      const failed = steps.find(step => step && (step.conclusion === 'failure' || step.conclusion === 'timed_out'))
      const job: CiJob = { name: str(one.name) || 'job', status: str(one.status), conclusion: str(one.conclusion) }
      if (failed) job.failedStep = str(failed.name)
      return job
    })
}

/** `git rev-list --left-right --count @{u}...HEAD` prints `behind<TAB>ahead`. */
export const parseAheadBehind = (stdout: string): { ahead: number; behind: number } | undefined => {
  const match = /^(\d+)\s+(\d+)\s*$/.exec(stdout.trim())
  return match ? { behind: Number(match[1]), ahead: Number(match[2]) } : undefined
}

/** Why `gh` could not answer, as one short line. */
export const ghReason = (stderr: string): string => {
  if (/auth login|not logged|authentication|GH_TOKEN/i.test(stderr)) return 'gh no tiene sesión iniciada (gh auth login)'
  if (/known GitHub host|no git remotes|not a git repository/i.test(stderr)) return 'el remoto no es de GitHub'
  const first = clean(stderr).split('\n').find(line => line.trim() !== '')
  return first ? `gh falló: ${first.trim().slice(0, 120)}` : 'gh no respondió'
}

/** Runs that were seen pending before and are finished now. */
export const finishedRuns = (before: CiRun[], after: CiRun[]): CiRun[] =>
  after.filter(run => !isRunActive(run) && before.some(prev => prev.id === run.id && isRunActive(prev)))

/** Conclusions that are neither a pass nor a failure: drawn as a dash, toasted by name. */
const NEUTRAL_LABEL: Record<string, string> = { cancelled: 'cancelado', skipped: 'omitido', neutral: 'neutral' }

export const verdictOfRun = (run: Pick<CiRun, 'conclusion'>): 'PASS' | 'FAIL' | 'NEUTRAL' =>
  run.conclusion === 'success' ? 'PASS' : Object.hasOwn(NEUTRAL_LABEL, run.conclusion) ? 'NEUTRAL' : 'FAIL'

export const toastOfRun = (run: Pick<CiRun, 'conclusion' | 'workflow'>): string => {
  const verdict = verdictOfRun(run)
  return `CI ${verdict === 'NEUTRAL' ? NEUTRAL_LABEL[run.conclusion] : verdict} · ${run.workflow}`
}

/** The one-line OS notification a finished run raises, naming the first failed job. */
export const notifyLineOfRun = (run: Pick<CiRun, 'conclusion' | 'workflow' | 'jobs'>): string => {
  const verdict = verdictOfRun(run)
  if (verdict === 'PASS') return `✓ CI ${run.workflow} pasó`
  if (verdict === 'NEUTRAL') return `– CI ${run.workflow} ${NEUTRAL_LABEL[run.conclusion]}`
  const job = run.jobs?.find(one => one.conclusion !== '' && one.conclusion !== 'success' && !Object.hasOwn(NEUTRAL_LABEL, one.conclusion))
  return `✗ CI ${run.workflow} falló${job ? ` · job ${job.name}` : ''}`
}

// ---------------------------------------------------------------- loading

const call = (run: Run, argv: readonly string[], cwd: string) => run(argv, { cwd, timeoutMs: RUN_TIMEOUT_MS }).catch(() => undefined)

/** Reads ahead/behind, then the runs of the newest pushed commit and their jobs. */
export const loadCi = async (run: Run, previous: CiView, now: number): Promise<CiView> => {
  const top = await gitTop(run)
  if (top === undefined) return { state: 'unavailable', reason: 'no hay repositorio git', runs: [], checkedAt: now }
  const remotes = await call(run, ['git', 'remote'], top)
  if (!remotes || remotes.exitCode !== 0 || remotes.stdout.trim() === '') return { state: 'unavailable', reason: 'el repositorio no tiene remoto', runs: [], checkedAt: now }

  const view: CiView = { state: 'ready', runs: [], checkedAt: now }
  const upstream = await call(run, ['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], top)
  if (upstream?.exitCode === 0) {
    view.upstream = clean(upstream.stdout.trim()).slice(0, 120)
    const counts = await call(run, ['git', 'rev-list', '--left-right', '--count', '@{u}...HEAD'], top)
    const parsed = counts?.exitCode === 0 ? parseAheadBehind(counts.stdout) : undefined
    if (parsed) Object.assign(view, parsed)
  }
  const ref = view.upstream !== undefined && (view.ahead ?? 0) > 0 ? '@{u}' : 'HEAD'
  const sha = await call(run, ['git', 'rev-parse', ref], top)
  if (sha?.exitCode !== 0 || !/^[0-9a-f]{7,64}$/.test(sha.stdout.trim())) return view
  view.sha = sha.stdout.trim()

  const listed = await call(run, ['gh', 'run', 'list', '--commit', view.sha, '--limit', '20', '--json', 'databaseId,name,status,conclusion,workflowName,headBranch,createdAt,url'], top)
  if (listed === undefined) return { ...view, state: 'unavailable', reason: 'gh no está instalado' }
  if (listed.exitCode !== 0) return { ...view, state: 'unavailable', reason: ghReason(listed.stderr) }

  const known = new Map(previous.runs.map(one => [one.id, one]))
  view.runs = await Promise.all(
    parseRuns(listed.stdout).map(async one => {
      const cached = known.get(one.id)
      // A finished run's jobs no longer change.
      if (cached?.jobs !== undefined && !isRunActive(cached) && !isRunActive(one)) return { ...one, jobs: cached.jobs }
      const detail = await call(run, ['gh', 'run', 'view', String(one.id), '--json', 'jobs'], top)
      const jobs = detail?.exitCode === 0 ? parseJobs(detail.stdout) : undefined
      return jobs === undefined ? (cached?.jobs ? { ...one, jobs: cached.jobs } : one) : { ...one, jobs }
    }),
  )
  return view
}

function refresh($: Api): Promise<void> {
  checking ??= (async () => {
    isDirty = false
    const [previous, now] = await Promise.all([read($, ciView), $.clock.now()])
    const next = await loadCi((argv, init) => $.process.run(argv, init), previous, now)
    await update($, ciView, () => next)
    for (const run of finishedRuns(previous.runs, next.runs)) {
      $.ui.toast(toastOfRun(run))
      void notify($, { key: `ci:${run.id}`, text: notifyLineOfRun(run) }).catch(() => undefined)
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      checking = undefined
    })
  return checking
}

async function isPaneUp($: Api): Promise<boolean> {
  const panes = await $.ui.panes().catch(() => [])
  return panes.some(pane => pane.id === PANE_ID && pane.isPlaced)
}

/** Every 30 s: checks when the pane is up and the view is due (30 s active, 5 min idle, or a push happened). */
async function tick($: Api): Promise<void> {
  if (checking !== undefined || !(await isPaneUp($))) return
  const [view, now] = await Promise.all([read($, ciView), $.clock.now()])
  if (isDirty || now - view.checkedAt >= pollEvery(view) - 1000) await refresh($)
}

function startTicker($: Api): void {
  ticker?.cancel()
  ticker = $.clock.every(ACTIVE_MS, () => {
    void tick($).catch(() => undefined)
  })
}

/** A check outside the timer, when one is due: the pane was just opened, a session started, a turn ended. */
export async function ciKick($: Api): Promise<void> {
  try {
    if (ticker === undefined) startTicker($)
  } catch {
    // No timer: kicks still check.
  }
  await tick($).catch(() => undefined)
}

const PUSHES = /\bgit\b[^;&|]*\bpush\b|\bgh\s+(?:pr\s+merge|workflow\s+run|run\s+rerun)\b/

export const registerCi = (on: Parameters<Register>[0]): void => {

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    try {
      const command = (e as unknown as Record<string, unknown>).command
      if (typeof command === 'string' && PUSHES.test(command)) isDirty = true
    } catch {
      // Never block the call over a status hint.
    }
    return result
  })
}

/** Atoms only: checks start from the timer and from `ciKick`, never from a draw. */
export async function readCi($: Api): Promise<CiPart> {
  const [view, now] = await Promise.all([read($, ciView), $.clock.now()])
  return { view, now }
}

// ---------------------------------------------------------------- rows

type Look = { glyph: string; color: string }

export const runLook = (run: Pick<CiRun, 'status' | 'conclusion'>): Look => {
  if (isRunActive(run)) return { glyph: '◷', color: 'warning' }
  if (run.conclusion === 'success') return { glyph: '✓', color: 'success' }
  if (verdictOfRun(run) === 'NEUTRAL') return { glyph: '–', color: 'subtle' }
  return { glyph: '✗', color: 'error' }
}

const jobLook = (job: CiJob): Look => runLook(job)

const pushLine = (view: CiView): string => {
  if (view.upstream === undefined) return 'Sin rama remota: haz git push -u para seguirla'
  const ahead = view.ahead ?? 0
  const behind = view.behind ?? 0
  if (ahead === 0 && behind === 0) return `Al día con ${view.upstream}`
  const parts = [ahead > 0 ? `↑ ${ahead} por subir` : '', behind > 0 ? `↓ ${behind} por bajar` : ''].filter(Boolean)
  return `${parts.join(' · ')} · ${view.upstream}`
}

const agoText = (iso: string, now: number): string => {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'ahora'
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `hace ${hours} h` : `hace ${Math.round(hours / 24)} d`
}

/** The fold arrow, the workflow and a letter of it before the age shows: below that the age goes first. */
const LABEL_MIN = 4
const JOB_INDENT_FROM = 8

/** How a run row splits its width: the label, one glyph column, then a space and the age when both fit. */
export const runRowLayout = (width: number, ago: string): { labelWidth: number; ago: string } => {
  const room = Math.max(1, width) - 1
  if (ago !== '' && room - ago.length - 1 >= LABEL_MIN) return { labelWidth: room - ago.length - 1, ago }
  return { labelWidth: room, ago: '' }
}

export const rowsCi = (
  part: CiPart,
  ctx: { width: number; accent: string; isOpen: (key: string, byDefault: boolean) => boolean },
): Row[] => {
  const { view, now } = part
  const width = Math.max(1, ctx.width)
  const line = (key: string, value: string, style: Omit<Span, 'text'> = {}): Row => ({ key, cells: [{ spans: [span(fit(value, width), style)] }] })

  if (view.state === 'idle') return [line('ci-loading', 'CI · consultando…', { dim: true })]
  if (view.state === 'unavailable' && view.upstream === undefined) return [line('ci-off', `CI no disponible: ${view.reason ?? 'sin datos'}`, { dim: true })]

  const ahead = view.ahead ?? 0
  const rows: Row[] = [line('ci-push', pushLine(view), { color: ahead > 0 ? 'warning' : 'subtle' })]
  if (view.state === 'unavailable') {
    rows.push(line('ci-off', `CI no disponible: ${view.reason ?? 'sin datos'}`, { dim: true }))
    return rows
  }
  const short = view.sha?.slice(0, 7) ?? ''
  if (view.runs.length === 0) {
    rows.push(line('ci-none', `CI · sin ejecuciones para ${short}`, { dim: true }))
    return rows
  }

  for (const run of view.runs) {
    const look = runLook(run)
    const key = `ci-run-${run.id}`
    const open = ctx.isOpen(key, look.glyph !== '✓')
    const label = `CI · ${run.workflow} `
    const layout = runRowLayout(width, agoText(run.createdAt, now))
    rows.push({
      key,
      cells: [
        {
          spans: [
            ...(layout.labelWidth > 0 ? [span(fit(`${open ? '▼' : '▶'} ${label}`, layout.labelWidth))] : []),
            span(look.glyph, { color: look.color, bold: true }),
          ],
          action: { kind: 'toggle', key },
          label: open ? 'Ocultar jobs' : 'Ver jobs',
          key: `btn-${key}`,
        },
      ],
      ...(layout.ago === '' ? {} : { right: [span(layout.ago, { dim: true })] }),
    })
    if (!open) continue
    rows.push(line(`${key}-meta`, `   ${run.branch || '—'} · ${short}${ahead > 0 ? ' (último commit subido)' : ''}`, { dim: true }))
    if (run.jobs === undefined) {
      rows.push(line(`${key}-nojobs`, '   sin detalle de jobs', { dim: true }))
      continue
    }
    run.jobs.forEach((job, index) => {
      const jl = jobLook(job)
      const indent = width >= JOB_INDENT_FROM ? '   ' : ''
      const nameWidth = width - indent.length - 1
      rows.push({
        key: `${key}-job-${index}`,
        cells: [{ spans: [span(indent), span(jl.glyph, { color: jl.color }), ...(nameWidth >= 2 ? [span(fit(` ${job.name}`, nameWidth))] : [])] }],
      })
      if (job.failedStep) rows.push(line(`${key}-job-${index}-step`, `     falló en: ${job.failedStep}`, { color: 'error' }))
    })
  }
  return rows
}

/** A compact token for the footer: the overall CI glyph and the commits left to push. */
export const footerCi = (part: CiPart): Span[] => {
  const { view } = part
  if (view.state !== 'ready') return []
  const spans: Span[] = []
  if (view.runs.length > 0) {
    const looks = view.runs.map(runLook)
    const worst = looks.find(one => one.glyph === '✗') ?? looks.find(one => one.glyph === '◷') ?? looks[0]!
    spans.push(span('CI ', { dim: true }), span(worst.glyph, { color: worst.color, bold: true }))
  }
  if ((view.ahead ?? 0) > 0) spans.push(span(`${spans.length > 0 ? ' ' : ''}↑${view.ahead}`, { color: 'warning' }))
  return spans
}

export async function ciSessionStart($: Api, e: Parameters<Hook<'session.start'>>[1], next: Parameters<Hook<'session.start'>>[2]): Promise<Awaited<ReturnType<Hook<'session.start'>>>> {
  try {
    startTicker($)
  } catch {
    // No timer: turn ends and pane opens still check.
  }
  const result = await next(e)
  void ciKick($).catch(() => undefined)
  return result
}

export async function ciTurnComplete($: Api, e: Parameters<Hook<'turn.complete'>>[1], next: Parameters<Hook<'turn.complete'>>[2]): Promise<Awaited<ReturnType<Hook<'turn.complete'>>>> {
  const result = await next(e)
  if (e.agentId === undefined) void ciKick($).catch(() => undefined)
  return result
}
