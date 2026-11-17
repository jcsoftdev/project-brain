import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { PreviewView } from '../types'
import {
  HEAD_BYTES,
  LAUNCH_TIMEOUT_MS,
  NVIM_TIMEOUT_MS,
  SNIFF_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  THUMB_TIMEOUT_MS,
  absoluteOf,
  baseName,
  cacheKey,
  checkTarget,
  createLatest,
  decodeBase64,
  detectPaths,
  editorArgv,
  editorCommand,
  floatExpr,
  hasPrivateKey,
  headLines,
  isDefaultSocketName,
  isNvim,
  isSecretName,
  isTerminalEditor,
  kindOf,
  looksBinary,
  nvimExprArgv,
  openExpr,
  pickServer,
  readOnlyNvimArgv,
  splitRoots,
  supacodeTabArgv,
  thumbnailArgv,
  toolTarget,
} from './core'
import type { Kind, Target } from './core'

type Api = Parameters<Hook<'ui.press'>>[0]

const PANE = 'file-preview'
const EXISTS_TTL_MS = 10_000

const EMPTY: PreviewView = { id: 0, title: '', note: '', lines: [], image: '', generation: 0 }
const view = atom({ plugin: 'project-brain-file-preview', key: 'view' } as const, EMPTY, { shape: 'view-1' })

type Env = {
  PB_EDITOR?: string
  VISUAL?: string
  EDITOR?: string
  PB_NVIM_SERVER?: string
  NVIM?: string
  PB_PREVIEW_ROOTS?: string
  PB_PREVIEW_IMAGES?: string
  SUPACODE_SOCKET_PATH?: string
  TMPDIR?: string
  USER?: string
}

const readEnv = async ($: Api): Promise<Env> => ({
  PB_EDITOR: await $.env.get('PB_EDITOR'),
  VISUAL: await $.env.get('VISUAL'),
  EDITOR: await $.env.get('EDITOR'),
  PB_NVIM_SERVER: await $.env.get('PB_NVIM_SERVER'),
  NVIM: await $.env.get('NVIM'),
  PB_PREVIEW_ROOTS: await $.env.get('PB_PREVIEW_ROOTS'),
  PB_PREVIEW_IMAGES: await $.env.get('PB_PREVIEW_IMAGES'),
  SUPACODE_SOCKET_PATH: await $.env.get('SUPACODE_SOCKET_PATH'),
  TMPDIR: await $.env.get('TMPDIR'),
  USER: await $.env.get('USER'),
})

const run = async ($: Api, argv: string[], timeoutMs: number) => {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch {
    return undefined
  }
}

const realDir = async ($: Api, path: string): Promise<string | undefined> => {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  return stat?.kind === 'dir' ? stat.realPath : undefined
}

const projectDirs = async ($: Api, env: Env): Promise<string[]> => {
  const spelled = [await $.session.cwd(), await $.session.root(), ...splitRoots(env.PB_PREVIEW_ROOTS)]
  const resolved = await Promise.all(spelled.map(path => realDir($, path)))
  return [...new Set(resolved.filter((path): path is string => path !== undefined))]
}

type Resolved = { real: string; size: number; mtimeMs: number; kind: Kind }

const resolveTarget = async ($: Api, env: Env, spelled: string): Promise<Resolved | string> => {
  const roots = await projectDirs($, env)
  const absolute = absoluteOf(spelled, await $.session.cwd())
  const stat = await $.fs.stat(absolute, { resolve: true }).catch(() => undefined)
  const verdict = checkTarget({ spelled: absolute, real: stat?.realPath, kind: stat?.kind, roots })
  if (!verdict.ok) return verdict.reason
  return { real: verdict.real, size: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0, kind: kindOf(verdict.real) }
}

const tell = ($: Api, text: string) => $.ui.toast(`file preview: ${text}`)

const sockets = async ($: Api, env: Env): Promise<string[]> => {
  if (env.TMPDIR === undefined || env.USER === undefined) return []
  const base = `${env.TMPDIR.replace(/\/+$/, '')}/nvim.${env.USER}`
  const dirs = await $.fs.list(base).catch(() => [])
  const found: string[] = []
  for (const dir of dirs) {
    if (dir.kind !== 'dir') continue
    const entries = await $.fs.list(`${base}/${dir.name}`).catch(() => [])
    for (const entry of entries) if (isDefaultSocketName(entry.name)) found.push(`${base}/${dir.name}/${entry.name}`)
  }
  return found
}

const findServer = async ($: Api, env: Env): Promise<string | undefined> =>
  pickServer({
    explicit: env.PB_NVIM_SERVER,
    inherited: env.NVIM,
    sockets: await sockets($, env),
    projectDirs: await projectDirs($, env),
    cwdOf: async server => {
      const answer = await run($, nvimExprArgv(server, 'getcwd()'), NVIM_TIMEOUT_MS)
      return answer?.exitCode === 0 ? answer.stdout.trim() : undefined
    },
  })

const hasSupacode = (env: Env) => (env.SUPACODE_SOCKET_PATH ?? '') !== ''

/** Refuses binaries and files whose first bytes hold a private key; answers the head as text otherwise. */
const sniffText = async ($: Api, real: string): Promise<string | undefined> => {
  const head = await $.fs.read(real, { as: 'bytes', offset: 0, length: SNIFF_BYTES }).catch(() => undefined)
  if (head === undefined) return undefined
  const bytes = decodeBase64(head.base64)
  if (looksBinary(bytes)) return undefined
  const text = new TextDecoder().decode(bytes)
  return hasPrivateKey(text) ? undefined : text
}

const showPane = async ($: Api, next: Omit<PreviewView, 'id'>, id: number) => {
  await update($, view, () => ({ ...next, id }))
  await $.ui.open({ id: PANE, title: next.title })
}

const thumbnail = async ($: Api, env: Env, target: Resolved, isCurrent: () => boolean): Promise<string | undefined> => {
  if (target.kind === 'text' || env.TMPDIR === undefined) return undefined
  const dir = `${env.TMPDIR.replace(/\/+$/, '')}/pb-file-preview`
  const out = `${dir}/${cacheKey(target.real, target.size, target.mtimeMs)}.png`
  if (await $.fs.exists(out).catch(() => false)) return out
  await $.fs.write(`${dir}/.keep`, '').catch(() => undefined)
  if (!isCurrent()) return undefined
  const made = await run($, thumbnailArgv(target.kind, target.real, out), THUMB_TIMEOUT_MS)
  return made?.exitCode === 0 && (await $.fs.exists(out).catch(() => false)) ? out : undefined
}

const openWithSystem = async ($: Api, real: string): Promise<boolean> => {
  const { platform } = await $.session.info()
  if (platform !== 'macos') return false
  return (await run($, ['open', real], LAUNCH_TIMEOUT_MS))?.exitCode === 0
}

let requests = 0
let latest: ReturnType<typeof createLatest> | undefined

const previewFile = async ($: Api, target: Target, surface: string): Promise<void> => {
  latest ??= createLatest(ms => $.clock.sleep(ms))
  const id = ++requests
  await latest.run(async isCurrent => {
    const env = await readEnv($)
    const found = await resolveTarget($, env, target.path)
    if (typeof found === 'string') return tell($, found)
    const title = baseName(found.real)

    if (found.kind !== 'text') {
      if (env.PB_PREVIEW_IMAGES === '1' && surface === 'terminal') {
        const png = await thumbnail($, env, found, isCurrent)
        if (!isCurrent()) return
        if (png !== undefined) return showPane($, { title, note: found.real, lines: [], image: png, generation: Math.floor(found.mtimeMs) }, id)
      }
      if (!(await openWithSystem($, found.real))) tell($, 'no viewer for this file here')
      return
    }

    const head = await sniffText($, found.real)
    if (head === undefined) return tell($, 'binary or key material, not previewed')
    if (!isCurrent()) return

    if (found.size <= TEXT_PREVIEW_MAX_BYTES) {
      const server = await findServer($, env)
      if (!isCurrent()) return
      if (server !== undefined) {
        const shown = await run($, nvimExprArgv(server, floatExpr(found.real, target.line)), NVIM_TIMEOUT_MS)
        if (shown?.exitCode === 0) return
      }
      if (hasSupacode(env)) {
        const tab = await run($, supacodeTabArgv(title, readOnlyNvimArgv(found.real, target.line), true), LAUNCH_TIMEOUT_MS)
        if (tab?.exitCode === 0) return
      }
    }

    const text = found.size <= SNIFF_BYTES ? head : await $.fs.read(found.real, { offset: 0, length: HEAD_BYTES }).catch(() => head)
    if (!isCurrent()) return
    const note = found.size > TEXT_PREVIEW_MAX_BYTES ? `${found.real} (over 2 MiB: the head only)` : found.real
    return showPane($, { title, note, lines: headLines(text), image: '', generation: 0 }, id)
  })
}

const openFile = async ($: Api, target: Target): Promise<void> => {
  const env = await readEnv($)
  const found = await resolveTarget($, env, target.path)
  if (typeof found === 'string') return tell($, found)
  if (found.kind !== 'text') {
    if (!(await openWithSystem($, found.real))) tell($, 'no viewer for this file here')
    return
  }
  const editor = editorCommand(env)
  if (isNvim(editor)) {
    const server = await findServer($, env)
    if (server !== undefined) {
      const opened = await run($, nvimExprArgv(server, openExpr(found.real, target.line)), NVIM_TIMEOUT_MS)
      if (opened?.exitCode === 0) return tell($, `opened ${baseName(found.real)} in Neovim`)
    }
  }
  const argv = editorArgv(editor, found.real, target.line)
  if (isTerminalEditor(editor)) {
    if (hasSupacode(env)) {
      const tab = await run($, supacodeTabArgv(baseName(found.real), argv, false), LAUNCH_TIMEOUT_MS)
      if (tab?.exitCode === 0) return
    }
    return tell($, 'no running Neovim for this project and no Supacode to open a tab in')
  }
  const launched = await run($, argv, LAUNCH_TIMEOUT_MS)
  if (launched?.exitCode !== 0) tell($, `${editor[0]} did not start`)
}

const existsCache = new Map<string, { at: number; ok: boolean }>()

/** Keeps only paths that are files inside the roots and not secret-named, so a reply's prose does not grow dead buttons. */
const existingTargets = async ($: Api, targets: Target[]): Promise<Target[]> => {
  const now = await $.clock.now()
  const cwd = await $.session.cwd()
  const kept: Target[] = []
  let roots: string[] | undefined
  for (const target of targets) {
    if (isSecretName(target.path)) continue
    const key = `${cwd}\u0000${target.path}`
    const cached = existsCache.get(key)
    let ok = cached !== undefined && now - cached.at < EXISTS_TTL_MS ? cached.ok : undefined
    if (ok === undefined) {
      roots ??= await projectDirs($, await readEnv($))
      const stat = await $.fs.stat(absoluteOf(target.path, cwd), { resolve: true }).catch(() => undefined)
      ok = checkTarget({ spelled: absoluteOf(target.path, cwd), real: stat?.realPath, kind: stat?.kind, roots }).ok
      existsCache.set(key, { at: now, ok })
    }
    if (ok) kept.push(target)
  }
  return kept
}

export const register: Register = on => {
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    const target = toolTarget(e.props.tool, e.props.input)
    if (target === undefined || isSecretName(target.path)) return row
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="row">
          <Text dimColor>  ↳ </Text>
          <Button key={`pv:${e.requestId}`} plain dimColor onPress={press => void previewFile($, target, press.surface)}>
            {baseName(target.path)}
          </Button>
          <Text dimColor> · </Text>
          <Button key={`op:${e.requestId}`} plain dimColor onPress={() => void openFile($, target)}>
            open
          </Button>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const row = await next(e)
    const targets = await existingTargets($, detectPaths(e.props.text))
    if (targets.length === 0) return row
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {row}
        {targets.map((target, index) => (
          <Box key={`row:${e.requestId}:${index}`} flexDirection="row">
            <Text dimColor>  ↳ </Text>
            <Button key={`pv:${e.requestId}:${index}`} plain dimColor onPress={press => void previewFile($, target, press.surface)}>
              {target.line > 0 ? `${target.path}:${target.line}` : target.path}
            </Button>
            <Text dimColor> · </Text>
            <Button key={`op:${e.requestId}:${index}`} plain dimColor onPress={() => void openFile($, target)}>
              open
            </Button>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const shown = await read($, view)
    const header = (
      <Box flexDirection="row">
        <Text bold wrap="truncate-end">{shown.title || 'Preview'}  </Text>
        <Button key="close" plain dimColor onPress={() => void $.ui.close({ id: PANE })}>
          close
        </Button>
      </Box>
    )
    if (shown.image !== '' && e.surface === 'terminal') {
      const { Image } = $.ui.resolve(e)
      const columns = Math.max(1, Math.min(255, e.props.bodyColumns))
      const rows = Math.max(1, Math.min(255, e.props.scroll.bodyRows - 3))
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor wrap="truncate-end">{shown.note}</Text>
          <Image key="picture" source={{ file: shown.image, format: 'png', generation: shown.generation }} columns={columns} rows={rows} alt={shown.title || ' '} />
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {header}
        <Text dimColor wrap="truncate-end">{shown.note}</Text>
        {shown.lines.map(line => (
          <Text wrap="truncate-end">{line === '' ? ' ' : line}</Text>
        ))}
      </Box>
    )
  })
}
