export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024
export const HEAD_BYTES = 64 * 1024
export const SNIFF_BYTES = 8192
export const DEBOUNCE_MS = 120
export const NVIM_TIMEOUT_MS = 1500
export const LAUNCH_TIMEOUT_MS = 5000
export const THUMB_TIMEOUT_MS = 8000
export const THUMB_MAX_PX = 800
export const FLOAT_MAX_LINES = 2000
export const PANE_LINES = 200
export const PANE_COLUMNS = 400
export const MAX_PATHS_PER_ROW = 6

export const PATH_TOOLS: readonly string[] = ['Read', 'Edit', 'Write']

/**
 * Names never previewed or opened: the owner records demos, so a key or a
 * token must never reach the screen by a click. Globs over the file's base
 * name, matched case-insensitively; one list, unit-tested.
 */
export const SECRET_NAMES: readonly string[] = [
  '.env*',
  '*.pem',
  '*.key',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  'credentials*',
  '*.p12',
  '*.pfx',
  '.npmrc',
  '.netrc',
  '.pgpass',
  '.git-credentials',
]

/** Directories whose whole content counts as secret, by any path component. */
export const SECRET_DIRS: readonly string[] = ['.ssh', '.gnupg', '.aws']

export const IMAGE_EXTS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic']
export const VIDEO_EXTS: readonly string[] = ['mp4', 'mov', 'webm', 'mkv']

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const UNSAFE_CHARS = /[\u0000-\u001f\u007f]/

export type Kind = 'text' | 'image' | 'video'
export type Target = { path: string; line: number }

const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')

const SECRET_PATTERNS = SECRET_NAMES.map(globToRegExp)

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const extensionOf = (path: string): string => {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export const kindOf = (path: string): Kind => {
  const ext = extensionOf(path)
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (VIDEO_EXTS.includes(ext)) return 'video'
  return 'text'
}

export const isSecretName = (path: string): boolean => {
  if (SECRET_PATTERNS.some(pattern => pattern.test(baseName(path)))) return true
  const dirs = path.split('/').slice(0, -1).map(part => part.toLowerCase())
  return SECRET_DIRS.some(dir => dirs.includes(dir))
}

export const isUnsafeSpelling = (path: string): boolean => path === '' || UNSAFE_CHARS.test(path)

export const hasPrivateKey = (head: string): boolean => PRIVATE_KEY.test(head)

export const looksBinary = (bytes: Uint8Array): boolean => {
  const end = Math.min(bytes.length, SNIFF_BYTES)
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true
  return false
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export const decodeBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let value = 0
  let at = 0
  for (const char of clean) {
    value = (value << 6) | B64.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at++] = (value >> bits) & 0xff
    }
  }
  return out.subarray(0, at)
}

/** Joins and folds `.`/`..` by spelling only; the guard still trusts `realPath` alone. */
export const absoluteOf = (spelled: string, cwd: string): string => {
  const joined = spelled.startsWith('/') ? spelled : `${cwd.replace(/\/+$/, '')}/${spelled}`
  const parts: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

export const isInside = (real: string, root: string): boolean => {
  const base = root.replace(/\/+$/, '')
  return base !== '' && (real === base || real.startsWith(`${base}/`))
}

export const splitRoots = (value: string | undefined): string[] =>
  (value ?? '').split(':').map(part => part.trim()).filter(part => part.startsWith('/'))

export type PathFacts = {
  spelled: string
  real: string | undefined
  kind: 'file' | 'dir' | 'other' | undefined
  roots: readonly string[]
}

export type Verdict = { ok: true; real: string } | { ok: false; reason: string }

/** The one gate in front of every preview and open: spelling, existence, roots, secret names. */
export const checkTarget = (facts: PathFacts): Verdict => {
  if (isUnsafeSpelling(facts.spelled)) return { ok: false, reason: 'the path holds a control character' }
  if (facts.real === undefined || facts.kind === undefined) return { ok: false, reason: 'the file does not exist' }
  if (isUnsafeSpelling(facts.real)) return { ok: false, reason: 'the path holds a control character' }
  if (facts.kind !== 'file') return { ok: false, reason: 'not a regular file' }
  if (!facts.roots.some(root => isInside(facts.real!, root))) return { ok: false, reason: 'outside the project roots' }
  if (isSecretName(facts.spelled) || isSecretName(facts.real)) return { ok: false, reason: 'a secret-like file is never shown' }
  return { ok: true, real: facts.real }
}

export const toolTarget = (tool: string, input: unknown): Target | undefined => {
  if (!PATH_TOOLS.includes(tool) || typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  const path = record.file_path
  if (typeof path !== 'string' || isUnsafeSpelling(path)) return undefined
  const offset = typeof record.offset === 'number' && record.offset > 0 ? Math.floor(record.offset) : 0
  return { path, line: tool === 'Read' ? offset : 0 }
}

const PATH_TOKEN = /(^|[\s(\[`'"])((?:\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,10})(?::(\d{1,7}))?(?=$|[\s)\]`'",;!?]|[.:](?:\s|$))/gm

/** Path-like tokens of a markdown text, first seen first: `src/a.ts`, `./b.md:12`, `/abs/c.json`. */
export const detectPaths = (text: string, limit = MAX_PATHS_PER_ROW): Target[] => {
  const found: Target[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(PATH_TOKEN)) {
    const path = match[2] ?? ''
    const start = (match.index ?? 0) + (match[1]?.length ?? 0)
    if (text.slice(Math.max(0, start - 3), start).includes('://')) continue
    if (!path.includes('/') && !/^[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(path)) continue
    if (/^\d+(\.\d+)+$/.test(path) || /^v\d/.test(path) || isUnsafeSpelling(path)) continue
    if (seen.has(path)) continue
    seen.add(path)
    found.push({ path, line: match[3] === undefined ? 0 : Number(match[3]) })
    if (found.length >= limit) break
  }
  return found
}

/** A command line as argv, no shell: single and double quotes, backslash escapes; undefined when a quote is left open. */
export const parseCommand = (line: string): string[] | undefined => {
  const words: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | undefined
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
      continue
    }
    if (char === '\\' && i + 1 < line.length && (quote === undefined || '"\\$`'.includes(line[i + 1]!))) {
      word += line[++i]
      hasWord = true
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      else word += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasWord = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasWord) words.push(word)
      word = ''
      hasWord = false
      continue
    }
    word += char
    hasWord = true
  }
  if (quote !== undefined) return undefined
  if (hasWord) words.push(word)
  return words
}

export type EditorEnv = { PB_EDITOR?: string; VISUAL?: string; EDITOR?: string }

export const editorCommand = (env: EditorEnv): string[] => {
  for (const value of [env.PB_EDITOR, env.VISUAL, env.EDITOR]) {
    if (value === undefined || value.trim() === '') continue
    const argv = parseCommand(value)
    if (argv !== undefined && argv.length > 0 && !argv.some(isUnsafeSpelling)) return argv
  }
  return ['nvim']
}

const TERMINAL_EDITORS = new Set(['nvim', 'vim', 'vi', 'nano', 'emacs', 'hx', 'helix', 'micro', 'kak', 'joe'])
const GOTO_EDITORS = new Set(['code', 'code-insiders', 'cursor', 'codium', 'windsurf'])
const COLON_EDITORS = new Set(['zed', 'subl'])

export const isNvim = (editor: readonly string[]): boolean => baseName(editor[0] ?? '') === 'nvim'

/** Editors that need a terminal of their own; anything else is a launcher that hands off and exits. */
export const isTerminalEditor = (editor: readonly string[]): boolean => TERMINAL_EDITORS.has(baseName(editor[0] ?? ''))

export const editorArgv = (editor: readonly string[], file: string, line: number): string[] => {
  const name = baseName(editor[0] ?? '')
  if (line > 0 && TERMINAL_EDITORS.has(name)) return [...editor, `+${line}`, '--', file]
  if (line > 0 && GOTO_EDITORS.has(name)) return [...editor, '-g', `${file}:${line}`]
  if (line > 0 && COLON_EDITORS.has(name)) return [...editor, `${file}:${line}`]
  return [...editor, file]
}

/** POSIX single quoting, for the one string a shell reads: the command a new terminal tab runs. */
export const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export const supacodeTabArgv = (title: string, command: readonly string[], background: boolean): string[] => [
  'supacode',
  'tab',
  'new',
  ...(background ? ['--background'] : []),
  '--title',
  title.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80),
  '--input',
  command.map(shQuote).join(' '),
]

export const readOnlyNvimArgv = (file: string, line: number): string[] => ['nvim', '-R', ...(line > 0 ? [`+${line}`] : []), '--', file]

/** A Vim single-quoted literal: no escapes inside, a quote doubled. */
export const vimString = (value: string): string => `'${value.replace(/'/g, "''")}'`

/**
 * Lua run inside the owner's Neovim through `luaeval(code, _A)`: a scratch
 * buffer (never the file's own) in a floating window opened with
 * `enter = false` and `focusable = false`, so focus, cursor and the current
 * window stay where they were. A non-focusable float cannot take `q`, so it
 * closes on the next cursor move, insert or buffer change in the owner's
 * window, or when the next preview replaces it.
 */
export const FLOAT_LUA = [
  '(function(a)',
  'local path, line, max = a[1], a[2], a[3]',
  'local api = vim.api',
  'local prev = vim.g.pb_file_preview_win',
  'if prev and api.nvim_win_is_valid(prev) then pcall(api.nvim_win_close, prev, true) end',
  'local lines = vim.fn.readfile(path, "", max)',
  'local buf = api.nvim_create_buf(false, true)',
  'api.nvim_buf_set_lines(buf, 0, -1, false, lines)',
  'vim.bo[buf].bufhidden = "wipe"',
  'vim.bo[buf].modifiable = false',
  'local ft = vim.filetype.match({ filename = path })',
  'local lang = ft and vim.treesitter.language.get_lang(ft)',
  'if lang then pcall(vim.treesitter.start, buf, lang) end',
  'local cols, rows = vim.o.columns, vim.o.lines',
  'local width = math.max(20, math.floor(cols * 0.8))',
  'local height = math.max(3, math.min(math.max(#lines, 1), math.floor(rows * 0.7)))',
  'local win = api.nvim_open_win(buf, false, { relative = "editor", row = math.floor((rows - height) / 2) - 1, col = math.floor((cols - width) / 2), width = width, height = height, style = "minimal", border = "rounded", title = " " .. vim.fn.fnamemodify(path, ":~:.") .. " ", title_pos = "center", focusable = false, zindex = 200 })',
  'if line > 0 and #lines > 0 then local target = math.min(line, #lines) api.nvim_win_call(win, function() vim.fn.winrestview({ lnum = target, topline = math.max(1, target - 3) }) end) end',
  'vim.g.pb_file_preview_win = win',
  'local group = api.nvim_create_augroup("pb_file_preview", { clear = true })',
  'api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI", "InsertEnter", "BufLeave" }, { group = group, once = true, callback = function() if api.nvim_win_is_valid(win) then pcall(api.nvim_win_close, win, true) end end })',
  'return win',
  'end)(_A)',
].join(' ')

export const OPEN_LUA = [
  '(function(a)',
  'vim.cmd.drop({ args = { vim.fn.fnameescape(a[1]) }, mods = { tab = 1 } })',
  'if a[2] > 0 then pcall(vim.api.nvim_win_set_cursor, 0, { a[2], 0 }) vim.cmd("normal! zz") end',
  'return 1',
  'end)(_A)',
].join(' ')

const luaevalExpr = (code: string, path: string, ...numbers: number[]): string =>
  `luaeval(${vimString(code)}, [${[vimString(path), ...numbers.map(n => String(Math.max(0, Math.floor(n))))].join(', ')}])`

export const floatExpr = (path: string, line: number, maxLines = FLOAT_MAX_LINES): string =>
  luaevalExpr(FLOAT_LUA, path, line, Math.max(maxLines, line + 100))

export const openExpr = (path: string, line: number): string => luaevalExpr(OPEN_LUA, path, line)

export const nvimExprArgv = (server: string, expr: string): string[] => ['nvim', '--server', server, '--remote-expr', expr]

/** Sockets Neovim makes by default under `$TMPDIR/nvim.$USER/<random>/`: `nvim.<pid>.0`. */
export const isDefaultSocketName = (name: string): boolean => /^nvim\.\d+\.0$/.test(name)

export type ServerSearch = {
  explicit?: string
  inherited?: string
  sockets: readonly string[]
  projectDirs: readonly string[]
  cwdOf: (server: string) => Promise<string | undefined>
}

/**
 * `PB_NVIM_SERVER`, then `$NVIM`, each used when it answers; then the first
 * default socket whose Neovim's cwd is the project's. A Neovim open on another
 * project never gets a float.
 */
export const pickServer = async (search: ServerSearch): Promise<string | undefined> => {
  for (const server of [search.explicit, search.inherited]) {
    if (server !== undefined && server !== '' && !isUnsafeSpelling(server) && (await search.cwdOf(server)) !== undefined) return server
  }
  const wanted = new Set(search.projectDirs.map(dir => dir.replace(/\/+$/, '')))
  for (const socket of search.sockets) {
    const cwd = await search.cwdOf(socket)
    if (cwd !== undefined && wanted.has(cwd.trim().replace(/\/+$/, ''))) return socket
  }
  return undefined
}

/** Plain lines for the pane: tabs as two spaces, control characters dropped, each line cut. */
export const headLines = (text: string, maxLines = PANE_LINES, maxColumns = PANE_COLUMNS): string[] =>
  text
    .split(/\r?\n/)
    .slice(0, maxLines)
    .map(line => line.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, maxColumns))

export const cacheKey = (real: string, size: number, mtimeMs: number): string => {
  let hash = 0x811c9dc5
  for (const char of `${real}\u0000${size}\u0000${mtimeMs}\u0000${THUMB_MAX_PX}`) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export const thumbnailArgv = (kind: 'image' | 'video', real: string, out: string): string[] =>
  kind === 'video'
    ? ['ffmpeg', '-v', 'error', '-ss', '1', '-i', real, '-frames:v', '1', '-vf', `scale='min(${THUMB_MAX_PX},iw)':-2`, '-y', out]
    : ['sips', '-s', 'format', 'png', '-Z', String(THUMB_MAX_PX), real, '--out', out]

export type Latest = {
  /**
   * Waits the debounce, then runs `work` only if no newer call came in; the
   * result comes back only while this call is still the newest. `isCurrent`
   * lets work stop between steps.
   */
  run<T>(work: (isCurrent: () => boolean) => Promise<T>): Promise<T | undefined>
}

export const createLatest = (sleep: (ms: number) => Promise<void>, delayMs = DEBOUNCE_MS): Latest => {
  let newest = 0
  return {
    async run(work) {
      const id = ++newest
      await sleep(delayMs)
      if (id !== newest) return undefined
      const isCurrent = () => id === newest
      const result = await work(isCurrent)
      return isCurrent() ? result : undefined
    },
  }
}
