import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { PreviewView } from '../types'
import {
  LAUNCH_TIMEOUT_MS,
  NVIM_TIMEOUT_MS,
  READ_TIMEOUT_MS,
  TEXT_PREVIEW_MAX_BYTES,
  THUMB_TIMEOUT_MS,
  absoluteOf,
  baseName,
  cacheKey,
  checkContent,
  checkTarget,
  createBoundedCache,
  createFailureMemo,
  createLatest,
  detectPaths,
  editorArgv,
  editorCommand,
  floatExpr,
  headLines,
  isDefaultSocketName,
  isForbiddenRoot,
  isNvim,
  isSecretName,
  isTerminalEditor,
  kindOf,
  nvimExprArgv,
  openExpr,
  parseReadOnce,
  pickServer,
  privateDirArgv,
  readOnceArgv,
  readOnlyNvimArgv,
  socketDirs,
  splitRoots,
  supacodeTabArgv,
  thumbnailArgv,
  toolTarget,
} from './core'
import type { Kind, Target } from './core'

type Api = Parameters<Hook<'ui.press'>>[0]

const PANE = 'file-preview'

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
  XDG_RUNTIME_DIR?: string
  USER?: string
  HOME?: string
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
  XDG_RUNTIME_DIR: await $.env.get('XDG_RUNTIME_DIR'),
  USER: await $.env.get('USER'),
  HOME: await $.env.get('HOME'),
})

/** `$.process.run` kills the child when `timeoutMs` passes and rejects; a rejection reads as no answer. */
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
  const home = env.HOME === undefined ? undefined : await realDir($, env.HOME)
  const spelled = [await $.session.cwd(), await $.session.root(), ...splitRoots(env.PB_PREVIEW_ROOTS)]
  const resolved = await Promise.all(spelled.map(path => realDir($, path)))
  return [...new Set(resolved.filter((path): path is string => path !== undefined && !isForbiddenRoot(path, home ?? env.HOME)))]
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
  const found: string[] = []
  for (const { dir, nested } of socketDirs(env)) {
    const entries = await $.fs.list(dir).catch(() => [])
    if (!nested) {
      for (const entry of entries) if (isDefaultSocketName(entry.name)) found.push(`${dir}/${entry.name}`)
      continue
    }
    for (const sub of entries) {
      if (sub.kind !== 'dir') continue
      const inner = await $.fs.list(`${dir}/${sub.name}`).catch(() => [])
      for (const entry of inner) if (isDefaultSocketName(entry.name)) found.push(`${dir}/${sub.name}/${entry.name}`)
    }
  }
  return found
}

const failures = createFailureMemo()

const findServer = async ($: Api, env: Env): Promise<string | undefined> => {
  const now = await $.clock.now()
  return pickServer({
    explicit: env.PB_NVIM_SERVER,
    inherited: env.NVIM,
    sockets: await sockets($, env),
    projectDirs: await projectDirs($, env),
    cwdOf: async server => {
      if (failures.isSkipped(server, now)) return undefined
      const answer = await run($, nvimExprArgv(server, 'getcwd()'), NVIM_TIMEOUT_MS)
      if (answer?.exitCode !== 0) {
        failures.fail(server, now)
        return undefined
      }
      failures.ok(server)
      return answer.stdout.trim()
    },
  })
}

const hasSupacode = (env: Env) => (env.SUPACODE_SOCKET_PATH ?? '') !== ''

type Checked = { ok: true; text: string; base64: string; truncated: boolean } | { ok: false; reason: string }

/** The one read of a preview's bytes; everything shown afterwards is these bytes, checked whole. */
const readChecked = async ($: Api, real: string): Promise<Checked> => {
  const done = await run($, readOnceArgv(real), READ_TIMEOUT_MS)
  if (done === undefined || done.exitCode !== 0) return { ok: false, reason: 'the file could not be read (perl is needed)' }
  const read = parseReadOnce(done.stdout)
  if (!read.ok) return read
  const shown = checkContent(read.bytes, bytes => new TextDecoder().decode(bytes))
  if (!shown.ok) return shown
  return { ok: true, text: shown.text, base64: read.base64, truncated: read.truncated || read.size > TEXT_PREVIEW_MAX_BYTES }
}

const showPane = async ($: Api, next: Omit<PreviewView, 'id'>, id: number) => {
  await update($, view, () => ({ ...next, id }))
  await $.ui.open({ id: PANE, title: next.title })
}

let ownDir: string | undefined

/** The mod's own 0700 directory from `mktemp -d`, made once per load. */
const privateDir = async ($: Api, env: Env): Promise<string | undefined> => {
  if (ownDir !== undefined) return ownDir
  const made = await run($, privateDirArgv(env.TMPDIR), LAUNCH_TIMEOUT_MS)
  const dir = made?.exitCode === 0 ? made.stdout.trim() : ''
  if (!dir.startsWith('/') || /[\u0000-\u001f]/.test(dir)) return undefined
  ownDir = dir
  return dir
}

const thumbnail = async ($: Api, env: Env, target: Resolved, isCurrent: () => boolean): Promise<string | undefined> => {
  if (target.kind === 'text') return undefined
  const dir = await privateDir($, env)
  if (dir === undefined) return undefined
  const out = `${dir}/${cacheKey(target.real, target.size, target.mtimeMs)}.png`
  if (await $.fs.exists(out).catch(() => false)) return out
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

    const checked = await readChecked($, found.real)
    if (!checked.ok) return tell($, `not previewed: ${checked.reason}`)
    if (!isCurrent()) return

    const server = await findServer($, env)
    if (!isCurrent()) return
    if (server !== undefined) {
      const shown = await run($, nvimExprArgv(server, floatExpr(found.real, checked.base64, target.line)), NVIM_TIMEOUT_MS)
      if (shown?.exitCode === 0) return
    }
    const copy = hasSupacode(env) ? await privateDir($, env) : undefined
    if (copy !== undefined) {
      const file = `${copy}/${cacheKey(found.real, found.size, found.mtimeMs)}-${title}`
      const written = await $.fs.write(file, checked.text).then(() => true, () => false)
      const tab = written ? await run($, supacodeTabArgv(title, readOnlyNvimArgv(file, target.line), true), LAUNCH_TIMEOUT_MS) : undefined
      if (tab?.exitCode === 0) return
    }

    const note = checked.truncated ? `${found.real} (the head only)` : found.real
    return showPane($, { title, note, lines: headLines(checked.text), image: '', generation: 0 }, id)
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
      if (opened?.exitCode === 0 && opened.stdout.trim() === '1') return tell($, `opened ${baseName(found.real)} in Neovim`)
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

const detected = createBoundedCache<Target[]>()

/** Shape only: no file system at render. The press runs every check. */
const replyTargets = (requestId: string, text: string): Target[] => {
  const key = `${requestId}\u0000${text.length}`
  const cached = detected.get(key)
  if (cached !== undefined) return cached
  const targets = detectPaths(text)
  detected.set(key, targets)
  return targets
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
    const targets = replyTargets(e.requestId, e.props.text)
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
