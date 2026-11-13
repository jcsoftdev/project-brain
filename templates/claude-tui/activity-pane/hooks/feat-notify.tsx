import type { Hook } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Api } from './register'
import { oneLine } from './register'
import { elapsed } from './feat-running'

/** One finished thing worth telling the person about, keyed so it is told once. */
export type NotifyItem = { key: string; text: string }

/** What is waiting to go out, and the keys already told. */
export type NotifyQueue = { pending: NotifyItem[]; seen: string[] }

export const COALESCE_MS = 5000
export const LONG_TURN_MS = 120_000
export const NOTIFY_TITLE = 'Claude · Actividad'
const SEEN_MAX = 200
const LINE_MAX = 240
const SHOWN_IN_BURST = 3

const notifyOn = atom({ plugin: 'project-brain-activity', key: 'notify' } as const, true, { shape: 'notify-1' })

// A reload drops these: what was pending is lost, and the transitions that raise items are not replayed.
let queue: NotifyQueue = { pending: [], seen: [] }
let flushTimer: { cancel: () => void } | undefined
let osKind: 'darwin' | 'linux' | 'other' | undefined

// ---------------------------------------------------------------- queue

/** Adds an item unless its key was already told or is waiting; `isFirst` says a new burst starts. */
export const enqueue = (state: NotifyQueue, item: NotifyItem): { queue: NotifyQueue; isAdded: boolean; isFirst: boolean } => {
  if (state.seen.includes(item.key) || state.pending.some(one => one.key === item.key)) return { queue: state, isAdded: false, isFirst: false }
  return { queue: { ...state, pending: [...state.pending, item] }, isAdded: true, isFirst: state.pending.length === 0 }
}

/** Empties the pending list into one message, remembering its keys. */
export const drain = (state: NotifyQueue): { queue: NotifyQueue; text: string | undefined } => {
  const text = burstText(state.pending)
  const seen = [...state.seen, ...state.pending.map(one => one.key)].slice(-SEEN_MAX)
  return { queue: { pending: [], seen }, text }
}

/** One item reads as itself; a burst reads as a count and its first few lines. */
export const burstText = (items: NotifyItem[]): string | undefined => {
  if (items.length === 0) return undefined
  if (items.length === 1) return items[0]?.text
  const shown = items.slice(0, SHOWN_IN_BURST).map(one => one.text)
  const rest = items.length - shown.length
  return `${items.length} terminaron: ${shown.join(' · ')}${rest > 0 ? ` · y ${rest} más` : ''}`
}

// ---------------------------------------------------------------- text

/** The line a main turn of over two minutes raises; nothing for a short or interrupted one. */
export const turnLine = (e: { reason: string; durationMs: number; agentId?: string }): string | undefined => {
  if (e.agentId !== undefined || e.reason === 'aborted' || e.durationMs < LONG_TURN_MS) return undefined
  const took = elapsed(e.durationMs)
  if (e.reason === 'error') return `✗ El turno falló por un error de la API · ${took}`
  if (e.reason === 'refusal') return `✗ El modelo rechazó el turno · ${took}`
  return `✓ Claude terminó el turno · ${took}`
}

/** AppleScript string literal body: backslashes and quotes escaped, one line. */
export const appleScriptText = (value: string): string => oneLine(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/** The argv that raises a desktop notification on this system; none where there is no known command. */
export const osNotifyArgv = (kind: 'darwin' | 'linux' | 'other', title: string, text: string): string[] | undefined => {
  if (kind === 'darwin') return ['/usr/bin/osascript', '-e', `display notification "${appleScriptText(text)}" with title "${appleScriptText(title)}"`]
  if (kind === 'linux') return ['notify-send', '--app-name=Claude', oneLine(title), oneLine(text)]
  return undefined
}

/** `/<pane command> notify on|off|test`: the new setting, a test, or a status read; undefined for any other args. */
export const parseNotifyArgs = (args: string): 'on' | 'off' | 'test' | 'status' | undefined => {
  const words = args.trim().toLowerCase().split(/\s+/)
  if (words[0] !== 'notify') return undefined
  const word = words[1] ?? ''
  if (word === '') return 'status'
  if (word === 'on' || word === 'off' || word === 'test') return word
  return undefined
}

// ---------------------------------------------------------------- engine

/** Queues one finished thing; the first of a burst starts the 5 s window that coalesces the rest. */
export async function notify($: Api, item: NotifyItem): Promise<void> {
  const added = enqueue(queue, { key: item.key, text: oneLine(item.text).slice(0, LINE_MAX) })
  queue = added.queue
  if (!added.isFirst) return
  flushTimer?.cancel()
  flushTimer = $.clock.after(COALESCE_MS, () => {
    flushTimer = undefined
    void flushNotify($).catch(() => undefined)
  })
}

/** Sends what the window gathered, unless the person turned notifications off. */
export async function flushNotify($: Api): Promise<void> {
  const drained = drain(queue)
  queue = drained.queue
  if (drained.text === undefined || !(await read($, notifyOn))) return
  await sendNotification($, drained.text)
}

/** The engine's own channel first; the system's notifier when that channel shows no text. */
export async function sendNotification($: Api, text: string): Promise<string> {
  const sent = await $.ui.notify(text, { title: NOTIFY_TITLE }).catch(() => undefined)
  if (sent?.isSent === true && sent.channel !== 'terminal_bell') return sent.channel
  if (sent?.isSent === false && sent.reason !== 'no-channel') return sent.reason
  const argv = osNotifyArgv(await systemKind($), NOTIFY_TITLE, text)
  if (argv === undefined) return sent?.isSent === true ? sent.channel : 'no-channel'
  const ran = await $.process.run(argv, { timeoutMs: 5000 }).catch(() => undefined)
  return ran?.exitCode === 0 ? argv[0] ?? 'os' : 'os-failed'
}

export async function systemKind($: Api): Promise<'darwin' | 'linux' | 'other'> {
  if (osKind !== undefined) return osKind
  const ran = await $.process.run(['uname', '-s'], { timeoutMs: 3000 }).catch(() => undefined)
  const name = ran?.exitCode === 0 ? ran.stdout.trim() : ''
  osKind = name === 'Darwin' ? 'darwin' : name === 'Linux' ? 'linux' : 'other'
  return osKind
}

/** Answers `/<pane command> notify …`; undefined when the args are not about notifications. */
export async function notifyCommand($: Api, command: string, args: string): Promise<{ text: string } | undefined> {
  const asked = parseNotifyArgs(args)
  if (asked === undefined) return undefined
  if (asked === 'on' || asked === 'off') {
    await update($, notifyOn, () => asked === 'on')
    return { text: asked === 'on' ? 'Notificaciones del sistema activadas.' : 'Notificaciones del sistema desactivadas.' }
  }
  if (asked === 'test') {
    const channel = await sendNotification($, '✓ Prueba de notificación del panel de actividad')
    return { text: `Notificación de prueba enviada (${channel}).` }
  }
  const isOn = await read($, notifyOn)
  return { text: `Notificaciones del sistema: ${isOn ? 'activadas' : 'desactivadas'}. Usa /${command} notify on|off|test.` }
}

export async function notifyTurnComplete($: Api, e: Parameters<Hook<'turn.complete'>>[1], next: Parameters<Hook<'turn.complete'>>[2]): Promise<Awaited<ReturnType<Hook<'turn.complete'>>>> {
  const done = await next(e)
  const line = turnLine(e)
  if (line !== undefined) await notify($, { key: `turn:${e.turnId}`, text: line }).catch(() => undefined)
  return done
}
