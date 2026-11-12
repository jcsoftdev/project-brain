import type { Hook, Register } from 'claude-code'

import type { DroppedEntry, Framed, GateConfig, Piece, Sent, SessionRecord, Verdict } from '../types'

type Api = Parameters<Hook<'prompt.attachment'>>[0]
type Attachment = Parameters<Hook<'prompt.attachment'>>[1]

const DAY_MS = 24 * 60 * 60_000
export const GATE_TIMEOUT_MS = 3_500
export const MIN_PIECE_CHARS = 300
export const MAX_GATE_FAILURES = 3
export const HEALTH_RETRY_MS = 10 * 60_000
export const SESSION_TTL_MS = 30 * DAY_MS
export const DROPPED_LOG_LIMIT = 100
const LOG_HEAD_CHARS = 160

export const DEFAULT_ALLOW = [
  'engram',
  'mem_',
  'project-brain',
  'brain-',
  'session-title',
  'session-color',
  'Model routing for delegated agents',
  'Suggested skill',
  'Suggested tool',
]

export const DEFAULT_CONFIG: GateConfig = { enabled: true, allow: DEFAULT_ALLOW }

export const FENCE_BEGIN = '<!-- project-brain:begin -->'
export const FENCE_END = '<!-- project-brain:end -->'

export const GATED_TYPES = new Set(['hook_additional_context', 'hook_success'])
export const GATED_HOOK_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse'])

const HOOK_FRAME = /^[^\n]*? hook (?:additional context|success): /
const COMPACTIONS_THAT_STAND = new Set(['manual', 'auto', 'plugin'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function parseConfig(text: string): GateConfig {
  try {
    const raw: unknown = JSON.parse(text)
    if (!isObject(raw)) return DEFAULT_CONFIG
    const extra = Array.isArray(raw.contextAllow) ? raw.contextAllow.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []
    return { enabled: raw.contextGate !== false, allow: [...DEFAULT_ALLOW, ...extra] }
  } catch {
    return DEFAULT_CONFIG
  }
}

export const allowed = (text: string, allow: readonly string[]): boolean => {
  const lower = text.toLowerCase()
  return allow.some(signature => lower.includes(signature.toLowerCase()))
}

/** A stray or missing fence leaves no line provably outside project-brain's block, so the whole body is kept. */
const fencesBalanced = (body: string): boolean => {
  let depth = 0
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === FENCE_BEGIN) depth++
    if (trimmed === FENCE_END && --depth < 0) return false
  }
  return depth === 0
}

export function splitAttachment(type: string, text: string, allow: readonly string[]): Framed {
  const frame = HOOK_FRAME.exec(text)?.[0] ?? ''
  const body = text.slice(frame.length)
  if (type === 'hook_success') return { frame, pieces: [{ text: body, allowed: allowed(body, allow) }] }
  if (!fencesBalanced(body)) return { frame, pieces: [{ text: body, allowed: true }] }
  const pieces: Piece[] = []
  let depth = 0
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === FENCE_BEGIN) depth++
    const lineAllowed = depth > 0 || allowed(line, allow)
    if (trimmed === FENCE_END) depth = Math.max(0, depth - 1)
    const last = pieces[pieces.length - 1]
    if (last !== undefined && last.allowed === lineAllowed) last.text += `\n${line}`
    else pieces.push({ text: line, allowed: lineAllowed })
  }
  return { frame, pieces }
}

export const askable = (piece: Piece): boolean => !piece.allowed && piece.text.trim().length >= MIN_PIECE_CHARS

export function assemble(framed: Framed, dropped: ReadonlySet<number>): string | null {
  const kept = framed.pieces.filter((_, index) => !dropped.has(index))
  if (kept.every(piece => piece.text.trim() === '')) return null
  return framed.frame + kept.map(piece => piece.text).join('\n')
}

export function parseVerdict(stdout: string, count: number): Verdict | null {
  const line = stdout.trim().split('\n').pop() ?? ''
  try {
    const raw: unknown = JSON.parse(line)
    if (!isObject(raw) || !Array.isArray(raw.keep) || raw.keep.length !== count || !raw.keep.every(k => typeof k === 'boolean')) return null
    const scores = Array.isArray(raw.scores) && raw.scores.length === count ? (raw.scores as Array<number | null>) : raw.keep.map(() => null)
    return { keep: raw.keep as boolean[], scores }
  } catch {
    return null
  }
}

export function gateHealthy(text: string, now: number): boolean {
  try {
    const raw: unknown = JSON.parse(text)
    if (!isObject(raw) || typeof raw.failures !== 'number' || raw.failures < MAX_GATE_FAILURES) return true
    return typeof raw.lastFailure === 'number' && now - raw.lastFailure >= HEALTH_RETRY_MS
  } catch {
    return true
  }
}

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

export function attachmentKey(epoch: number, e: { type: string; text: string; origin: { kind: string; event?: string } }): string {
  const source = `${epoch}\u0000${e.type}\u0000${e.origin.kind}\u0000${e.origin.event ?? ''}\u0000${e.text}`
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}:${source.length}`
}

export const replayed = (sent: Sent, original: string): string | null => (sent === true ? original : sent.text)

export function answerIn(record: SessionRecord, e: Parameters<typeof attachmentKey>[1]): Sent | undefined {
  for (let epoch = record.epoch; epoch >= 0; epoch--) {
    const sent = record.sent[attachmentKey(epoch, e)]
    if (sent !== undefined) return sent
  }
  return undefined
}

async function readOr($: Api, path: string, fallback: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return fallback
  }
}

const sessionKey = (sessionId: string) => `session:${sessionId}`

const STORE_UNREADABLE = Symbol('store unreadable')

async function readRecord($: Api, sessionId: string): Promise<SessionRecord | typeof STORE_UNREADABLE> {
  let raw: unknown
  try {
    raw = await $.store.get(sessionKey(sessionId))
  } catch {
    return STORE_UNREADABLE
  }
  if (isObject(raw) && typeof raw.epoch === 'number' && isObject(raw.sent)) return raw as SessionRecord
  return { epoch: 0, touched: 0, sent: {} }
}

async function writeRecord($: Api, sessionId: string, record: SessionRecord): Promise<boolean> {
  try {
    await $.store.set(sessionKey(sessionId), { ...record, touched: await $.clock.now() })
    return true
  } catch {
    return false
  }
}

async function pruneSessions($: Api, keepSessionId: string): Promise<void> {
  const cutoff = (await $.clock.now()) - SESSION_TTL_MS
  for (const key of await $.store.keys()) {
    if (!key.startsWith('session:') || key === sessionKey(keepSessionId)) continue
    const raw = await $.store.get(key)
    if (!isObject(raw) || typeof raw.touched !== 'number' || raw.touched < cutoff) await $.store.delete(key)
  }
}

async function gateConfig($: Api, home: string): Promise<GateConfig> {
  return parseConfig(await readOr($, `${home}/.project-brain/skills.json`, ''))
}

async function gateReady($: Api, home: string, config: GateConfig): Promise<boolean> {
  if (!config.enabled || (await $.env.get('BRAIN_CONTEXT_GATE')) === '0') return false
  if (!tokenShaped(await $.env.get('TYPESAFE_API_KEY'), await readOr($, `${home}/.project-brain/reranker.json`, ''))) return false
  return gateHealthy(await readOr($, `${home}/.project-brain/context-gate-health.json`, ''), await $.clock.now())
}

async function judge($: Api, prompt: string, segments: string[]): Promise<Verdict | null> {
  const { exitCode, stdout } = await $.process.run(['project-brain', 'suggest', '--context', '--stdin'], {
    stdin: JSON.stringify({ prompt, segments }),
    timeoutMs: GATE_TIMEOUT_MS,
  })
  return exitCode === 0 ? parseVerdict(stdout, segments.length) : null
}

async function logDropped($: Api, home: string, entries: DroppedEntry[]): Promise<void> {
  if (entries.length === 0) return
  const path = `${home}/.project-brain/context-gate-log.json`
  let earlier: DroppedEntry[] = []
  try {
    const raw: unknown = JSON.parse(await readOr($, path, '{}'))
    if (isObject(raw) && Array.isArray(raw.dropped)) earlier = raw.dropped as DroppedEntry[]
  } catch {
    earlier = []
  }
  const dropped = [...earlier, ...entries].slice(-DROPPED_LOG_LIMIT)
  await $.fs.write(path, `${JSON.stringify({ dropped }, null, 2)}\n`)
}

type Gate = {
  prompts: Map<string, string>
  answers: Map<string, Sent>
  replayOnly: boolean
  submittedHere: boolean
  queue: Promise<unknown>
}

type Decision = { text: string | null; dropped: DroppedEntry[] }

async function decide($: Api, gate: Gate, e: Attachment, sessionId: string, home: string): Promise<Decision> {
  const unchanged: Decision = { text: e.text, dropped: [] }
  if (gate.replayOnly) return unchanged
  const prompt = gate.prompts.get(sessionId)
  if (prompt === undefined) return unchanged
  const config = await gateConfig($, home)
  if (!(await gateReady($, home, config))) return unchanged
  const framed = splitAttachment(e.type, e.text, config.allow)
  const asked = framed.pieces.flatMap((piece, index) => (askable(piece) ? [index] : []))
  if (asked.length === 0) return unchanged
  const verdict = await judge($, prompt, asked.map(index => framed.pieces[index]!.text))
  if (verdict === null) return unchanged
  const droppedAt = asked.filter((_, n) => !verdict.keep[n])
  if (droppedAt.length === 0) return unchanged
  const now = await $.clock.now()
  const origin = e.origin as { event?: string }
  return {
    text: assemble(framed, new Set(droppedAt)),
    dropped: droppedAt.map(index => {
      const piece = framed.pieces[index]!.text
      return {
        at: now,
        session: sessionId,
        type: e.type,
        event: origin.event ?? '',
        chars: piece.length,
        score: verdict.scores[asked.indexOf(index)] ?? null,
        head: piece.trim().slice(0, LOG_HEAD_CHARS),
      }
    }),
  }
}

async function gated($: Api, gate: Gate, e: Attachment): Promise<string | null> {
  const sessionId = await $.session.id()
  const inProcess = `${sessionId}\u0000${attachmentKey(0, e)}`
  const given = gate.answers.get(inProcess)
  if (given !== undefined) return replayed(given, e.text)
  const answer = (sent: Sent) => (gate.answers.set(inProcess, sent), replayed(sent, e.text))

  const record = await readRecord($, sessionId)
  if (record === STORE_UNREADABLE) return answer(true)
  const earlier = answerIn(record, e)
  if (earlier !== undefined) return answer(earlier)

  const home = await $.env.get('HOME')
  const decision = home ? await decide($, gate, e, sessionId, home).catch((): Decision => ({ text: e.text, dropped: [] })) : { text: e.text, dropped: [] }
  const sent: Sent = decision.text === e.text ? true : { text: decision.text }
  const persisted = await writeRecord($, sessionId, { ...record, sent: { ...record.sent, [attachmentKey(record.epoch, e)]: sent } })
  if (!persisted) return answer(true)
  if (home) await logDropped($, home, decision.dropped).catch(() => undefined)
  return answer(sent)
}

export const gatedOrigin = (e: { type: string; origin: { kind: string; event?: string }; agentId?: string }): boolean => {
  if (e.agentId !== undefined || !GATED_TYPES.has(e.type)) return false
  if (e.origin.kind === 'plugin') return true
  return e.origin.kind === 'hook' && GATED_HOOK_EVENTS.has(e.origin.event ?? '')
}

function inTurn<T>(gate: Gate, work: () => Promise<T>): Promise<T> {
  const run = gate.queue.then(work, work)
  gate.queue = run.catch(() => undefined)
  return run
}

export function createGate(): Gate {
  return { prompts: new Map(), answers: new Map(), replayOnly: false, submittedHere: false, queue: Promise.resolve() }
}

export const register: Register = on => {
  const gate = createGate()

  on('session.start', async ($, e, next) => {
    try {
      gate.replayOnly = (await $.session.turns()) > 0
      void pruneSessions($ as unknown as Api, await $.session.id()).catch(() => undefined)
    } catch {
      gate.replayOnly = true
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined && e.isMeta !== true) {
      const sessionId = await $.session.id().catch(() => null)
      if (sessionId !== null) gate.prompts.set(sessionId, e.text)
      gate.submittedHere = true
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && gate.submittedHere) gate.replayOnly = false
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || !COMPACTIONS_THAT_STAND.has(e.trigger) || result.skip !== undefined) return result
    await inTurn(gate, async () => {
      const sessionId = await $.session.id()
      const record = await readRecord($ as unknown as Api, sessionId)
      if (record !== STORE_UNREADABLE) await writeRecord($ as unknown as Api, sessionId, { ...record, epoch: record.epoch + 1 })
    }).catch(() => undefined)
    return result
  })

  on('prompt.attachment', async ($, e, next) => {
    if (!gatedOrigin(e)) return next(e)
    try {
      const text = await inTurn(gate, () => gated($, gate, e))
      if (text === null) return { text: null }
      return text === e.text ? next(e) : next({ ...e, text })
    } catch {
      return next(e)
    }
  })
}
