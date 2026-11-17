export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024
export const READ_CAP_BYTES = 192 * 1024
export const DEBOUNCE_MS = 120
export const NVIM_TIMEOUT_MS = 700
export const READ_TIMEOUT_MS = 2000
export const LAUNCH_TIMEOUT_MS = 5000
export const THUMB_TIMEOUT_MS = 8000
export const THUMB_MAX_PX = 800
export const FAILED_SERVER_TTL_MS = 30_000
export const PANE_LINES = 200
export const PANE_COLUMNS = 400
export const MAX_PATHS_PER_ROW = 6
export const RENDER_CACHE_LIMIT = 200

export const PATH_TOOLS: readonly string[] = ['Read', 'Edit', 'Write']

/**
 * Names never previewed or opened: the owner records demos, so a key or a
 * token must never reach the screen by a click. Globs matched,
 * case-insensitively, against the file's name and against every directory
 * between the project root and it.
 */
export const SECRET_NAMES: readonly string[] = [
  '.env*',
  'env.production*',
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
  '.pypirc',
  'kubeconfig*',
  'secrets.*',
  '*.tfvars',
  '*.tfvars.json',
  'terraform.tfstate*',
  '.dev.vars',
  '*.kdbx',
  '*.token',
  '.vault-token',
  '*.asc',
  '*.ppk',
  '.htpasswd',
  '.mcp.json',
  '*.keystore',
  '*.jks',
  'service-account*.json',
  '.zsh_history',
  '.bash_history',
  '.claude.json',
]

/** Directories whose whole content counts as secret, at any depth. */
export const SECRET_DIRS: readonly string[] = ['.ssh', '.gnupg', '.aws', '.kube']

/** Globs over the last components of the path: a file secret only in its directory. */
export const SECRET_PATHS: readonly string[] = ['.docker/config.json', '.git/config', '.claude/settings*.json', '.config/gh/hosts.yml']

/**
 * Content that refuses a whole preview, by label; the label is what the
 * person is told, never the text that matched.
 */
export const SECRET_CONTENT: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'a private key', pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/ },
  { label: 'a PuTTY key', pattern: /PuTTY-User-Key-File-\d/ },
  { label: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'a GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})/ },
  { label: 'an API key (sk-)', pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/ },
  { label: 'a Slack token', pattern: /\bxox[abpor]-[A-Za-z0-9-]{10,}/ },
  { label: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { label: 'a JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
]

const ASSIGNMENT = /(?:password|passwd|secret|token|api[_-]?key)[\w.-]{0,40}["']?[ \t]{0,8}[:=][ \t]{0,8}["']?([A-Za-z0-9+/=_-]{16,512})/gi

export const IMAGE_EXTS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic']
export const VIDEO_EXTS: readonly string[] = ['mp4', 'mov', 'webm', 'mkv']

const UNSAFE_CHARS = /[\u0000-\u001f\u007f]/

export type Kind = 'text' | 'image' | 'video'
export type Target = { path: string; line: number }

const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')

const NAME_PATTERNS = SECRET_NAMES.map(globToRegExp)
const PATH_PATTERNS = SECRET_PATHS.map(glob => glob.split('/').map(globToRegExp))

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

export const isInside = (real: string, root: string): boolean => {
  const base = root.replace(/\/+$/, '')
  if (base === '') return real.startsWith('/')
  return real === base || real.startsWith(`${base}/`)
}

/** The components under the root that holds the path, or all of them when none does. */
const componentsUnder = (path: string, roots: readonly string[]): string[] => {
  const root = roots.find(candidate => isInside(path, candidate))
  const rest = root === undefined ? path : path.slice(root.replace(/\/+$/, '').length)
  return rest.split('/').filter(part => part !== '')
}

export const isSecretName = (path: string, roots: readonly string[] = []): boolean => {
  const parts = componentsUnder(path, roots)
  if (parts.some(part => NAME_PATTERNS.some(pattern => pattern.test(part)))) return true
  if (parts.slice(0, -1).some(part => SECRET_DIRS.includes(part.toLowerCase()))) return true
  return PATH_PATTERNS.some(globs => globs.length <= parts.length && globs.every((glob, i) => glob.test(parts[parts.length - globs.length + i]!)))
}

/** The label of the first secret the text holds, or undefined. */
export const secretInContent = (text: string): string | undefined => {
  for (const { label, pattern } of SECRET_CONTENT) if (pattern.test(text)) return label
  for (const match of text.matchAll(ASSIGNMENT)) {
    const value = match[1] ?? ''
    if (/[0-9]/.test(value) && /[A-Za-z]/.test(value)) return 'a password or token assignment'
  }
  return undefined
}

export const isUnsafeSpelling = (path: string): boolean => path === '' || UNSAFE_CHARS.test(path)

export const looksBinary = (bytes: Uint8Array): boolean => bytes.includes(0)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export const decodeBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let value = 0
  let at = 0
  for (const char of clean) {
    value = ((value << 6) | B64.indexOf(char)) & 0xffffff
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

export const splitRoots = (value: string | undefined): string[] =>
  (value ?? '').split(':').map(part => part.trim()).filter(part => part.startsWith('/'))

/** A root that is the home folder or `/` would put every dotfile in reach: never a preview root. */
export const isForbiddenRoot = (real: string, home: string | undefined): boolean => {
  const trimmed = real.replace(/\/+$/, '')
  return trimmed === '' || (home !== undefined && home !== '' && trimmed === home.replace(/\/+$/, ''))
}

export type PathFacts = {
  spelled: string
  real: string | undefined
  kind: 'file' | 'dir' | 'other' | undefined
  roots: readonly string[]
}

export type Verdict = { ok: true; real: string } | { ok: false; reason: string }

/** The gate by name and place, in front of every preview and open; the bytes are checked again when read. */
export const checkTarget = (facts: PathFacts): Verdict => {
  if (isUnsafeSpelling(facts.spelled)) return { ok: false, reason: 'the path holds a control character' }
  if (facts.roots.length === 0) return { ok: false, reason: 'no project root to preview from (home and / are never one)' }
  if (facts.real === undefined || facts.kind === undefined) return { ok: false, reason: 'the file does not exist' }
  if (isUnsafeSpelling(facts.real)) return { ok: false, reason: 'the path holds a control character' }
  if (facts.kind !== 'file') return { ok: false, reason: 'not a regular file' }
  if (!facts.roots.some(root => isInside(facts.real!, root))) return { ok: false, reason: 'outside the project roots' }
  if (isSecretName(baseName(facts.spelled)) || isSecretName(facts.real, facts.roots)) return { ok: false, reason: 'a secret-like file is never shown' }
  return { ok: true, real: facts.real }
}

/**
 * Reads a file once, by argv: opened with O_NOFOLLOW (a symlink swapped in
 * fails) and O_NONBLOCK (a FIFO cannot hang it), then fstat on that handle:
 * a regular file with one link, still reachable at the same absolute path
 * with no symlink on the way. Prints `OK <size> <truncated>` and the base64
 * of at most `cap` bytes, or `ERR <code>`.
 */
export const READ_ONCE_PERL = [
  'use strict;',
  'use Fcntl qw(O_RDONLY O_NOFOLLOW O_NONBLOCK S_ISREG);',
  'use Cwd qw(abs_path);',
  'use MIME::Base64 qw(encode_base64);',
  'my ($path, $cap) = @ARGV;',
  'sub out { print "ERR $_[0]\\n"; exit 0 }',
  'sysopen(my $fh, $path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or out("open");',
  'my @st = stat($fh) or out("open");',
  'S_ISREG($st[2]) or out("notfile");',
  '$st[3] == 1 or out("links");',
  'my $now = abs_path($path);',
  'my @again = lstat($path);',
  '(defined $now && $now eq $path && @again && $again[0] == $st[0] && $again[1] == $st[1]) or out("moved");',
  'my $want = $st[7] < $cap ? $st[7] : $cap;',
  'my $buf = "";',
  'while (length($buf) < $want) { my $n = sysread($fh, $buf, $want - length($buf), length($buf)); last unless $n; }',
  'print "OK $st[7] ", ($st[7] > length($buf) ? 1 : 0), "\\n", encode_base64($buf, ""), "\\n";',
].join(' ')

export const readOnceArgv = (real: string, cap = READ_CAP_BYTES): string[] => ['perl', '-e', READ_ONCE_PERL, '--', real, String(cap)]

const READ_ERRORS: Record<string, string> = {
  open: 'the file could not be opened without following a link',
  notfile: 'not a regular file',
  links: 'a file with more than one hard link is never shown',
  moved: 'the file moved while it was being read',
}

export type ReadOnce = { ok: true; size: number; truncated: boolean; base64: string; bytes: Uint8Array } | { ok: false; reason: string }

export const parseReadOnce = (stdout: string): ReadOnce => {
  const [head = '', body = ''] = stdout.split('\n')
  const error = /^ERR (\w+)$/.exec(head)
  if (error) return { ok: false, reason: READ_ERRORS[error[1]!] ?? 'the file could not be read' }
  const ok = /^OK (\d+) ([01])$/.exec(head)
  if (!ok || !/^[A-Za-z0-9+/=]*$/.test(body)) return { ok: false, reason: 'the file could not be read' }
  return { ok: true, size: Number(ok[1]), truncated: ok[2] === '1', base64: body, bytes: decodeBase64(body) }
}

export type Shown = { ok: true; text: string } | { ok: false; reason: string }

/** Every byte that will be shown, checked: not binary, no secret by content. */
export const checkContent = (bytes: Uint8Array, decode: (bytes: Uint8Array) => string): Shown => {
  if (looksBinary(bytes)) return { ok: false, reason: 'a binary file is not previewed' }
  const text = decode(bytes)
  const secret = secretInContent(text)
  return secret === undefined ? { ok: true, text } : { ok: false, reason: `it holds what looks like ${secret}` }
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

/**
 * Path-like tokens of a markdown text, first seen first, by shape alone (no
 * file system at render): anything with a slash, or a bare `name.ext` inside
 * a code span, so prose such as "Node.js" grows no button.
 */
export const detectPaths = (text: string, limit = MAX_PATHS_PER_ROW): Target[] => {
  const found: Target[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(PATH_TOKEN)) {
    const path = match[2] ?? ''
    const start = (match.index ?? 0) + (match[1]?.length ?? 0)
    if (text.slice(Math.max(0, start - 3), start).includes('://')) continue
    const isBare = !path.includes('/')
    if (isBare && (match[1] !== '`' || !/^[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(path))) continue
    if (/^\d+(\.\d+)+$/.test(path) || isUnsafeSpelling(path) || isSecretName(path)) continue
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

/**
 * POSIX single quoting, for the one string a shell reads: the command a new
 * Supacode tab runs. Checked against `sh`; fish reads `\'` inside single
 * quotes differently and is not covered.
 */
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
 * Lua run inside the owner's Neovim through `luaeval(code, _A)`. It never
 * opens the path: the lines arrive as base64 of the bytes the mod read and
 * checked, the path is only the title. A scratch buffer in a floating window
 * opened with `enter = false` and `focusable = false`, so focus, cursor and
 * the current window stay put. A non-focusable float cannot take `q`, so it
 * closes on the next cursor move, insert or buffer change in the owner's
 * window, or when the next preview replaces it.
 */
export const FLOAT_LUA = [
  '(function(a)',
  'local title, data, line = a[1], a[2], a[3]',
  'local api = vim.api',
  'local prev = vim.g.pb_file_preview_win',
  'if prev and api.nvim_win_is_valid(prev) then pcall(api.nvim_win_close, prev, true) end',
  'local lines = vim.split(vim.base64.decode(data), "\\n", { plain = true })',
  'for i, l in ipairs(lines) do lines[i] = l:gsub("\\r$", "") end',
  'if #lines > 1 and lines[#lines] == "" then table.remove(lines) end',
  'local buf = api.nvim_create_buf(false, true)',
  'api.nvim_buf_set_lines(buf, 0, -1, false, lines)',
  'vim.bo[buf].bufhidden = "wipe"',
  'vim.bo[buf].modifiable = false',
  'local ft = vim.filetype.match({ filename = title, buf = buf })',
  'local lang = ft and vim.treesitter.language.get_lang(ft)',
  'if lang then pcall(vim.treesitter.start, buf, lang) end',
  'local cols, rows = vim.o.columns, vim.o.lines',
  'local width = math.max(20, math.floor(cols * 0.8))',
  'local height = math.max(3, math.min(math.max(#lines, 1), math.floor(rows * 0.7)))',
  'local win = api.nvim_open_win(buf, false, { relative = "editor", row = math.floor((rows - height) / 2) - 1, col = math.floor((cols - width) / 2), width = width, height = height, style = "minimal", border = "rounded", title = " " .. vim.fn.fnamemodify(title, ":~:.") .. " ", title_pos = "center", focusable = false, zindex = 200 })',
  'if line > 0 and #lines > 0 then local target = math.min(line, #lines) api.nvim_win_call(win, function() vim.fn.winrestview({ lnum = target, topline = math.max(1, target - 3) }) end) end',
  'vim.g.pb_file_preview_win = win',
  'local group = api.nvim_create_augroup("pb_file_preview", { clear = true })',
  'api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI", "InsertEnter", "BufLeave" }, { group = group, once = true, callback = function() if api.nvim_win_is_valid(win) then pcall(api.nvim_win_close, win, true) end end })',
  'return win',
  'end)(_A)',
].join(' ')

/** `tab drop` at the line, only while the path is still a regular file: a FIFO swapped in would hang the editor. */
export const OPEN_LUA = [
  '(function(a)',
  'local st = vim.uv.fs_lstat(a[1])',
  'if not st or st.type ~= "file" then return 0 end',
  'vim.cmd.drop({ args = { vim.fn.fnameescape(a[1]) }, mods = { tab = 1 } })',
  'if a[2] > 0 then pcall(vim.api.nvim_win_set_cursor, 0, { a[2], 0 }) vim.cmd("normal! zz") end',
  'return 1',
  'end)(_A)',
].join(' ')

const whole = (n: number) => String(Math.max(0, Math.floor(n)))

export const floatExpr = (title: string, base64: string, line: number): string =>
  `luaeval(${vimString(FLOAT_LUA)}, [${vimString(title)}, ${vimString(base64.replace(/[^A-Za-z0-9+/=]/g, ''))}, ${whole(line)}])`

export const openExpr = (path: string, line: number): string => `luaeval(${vimString(OPEN_LUA)}, [${vimString(path)}, ${whole(line)}])`

export const nvimExprArgv = (server: string, expr: string): string[] => ['nvim', '--server', server, '--remote-expr', expr]

/** Sockets Neovim makes by default: `nvim.<pid>.0`. */
export const isDefaultSocketName = (name: string): boolean => /^nvim\.\d+\.0$/.test(name)

export type SocketEnv = { TMPDIR?: string; XDG_RUNTIME_DIR?: string; USER?: string }

/**
 * Where Neovim's `stdpath("run")` puts default sockets: `<TMPDIR or /tmp>/nvim.$USER/<random>/`
 * (macOS, and Linux without a runtime dir), or `$XDG_RUNTIME_DIR` itself (Linux).
 */
export const socketDirs = (env: SocketEnv): Array<{ dir: string; nested: boolean }> => {
  const trim = (dir: string) => dir.replace(/\/+$/, '')
  const dirs: Array<{ dir: string; nested: boolean }> = []
  if (env.USER !== undefined && env.USER !== '' && !env.USER.includes('/')) {
    for (const base of [env.TMPDIR, '/tmp']) if (base !== undefined && base !== '') dirs.push({ dir: `${trim(base)}/nvim.${env.USER}`, nested: true })
  }
  if (env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR !== '') dirs.push({ dir: trim(env.XDG_RUNTIME_DIR), nested: false })
  return dirs.filter((entry, index) => dirs.findIndex(other => other.dir === entry.dir) === index)
}

export type ServerSearch = {
  explicit?: string
  inherited?: string
  sockets: readonly string[]
  projectDirs: readonly string[]
  cwdOf: (server: string) => Promise<string | undefined>
}

/**
 * Every candidate is asked at once, so the search costs one timeout, not one
 * per socket. Then by rank: `PB_NVIM_SERVER`, `$NVIM`, each used when it
 * answers; then the first default socket whose Neovim's cwd is the project's.
 * A Neovim open on another project never gets a float.
 */
export const pickServer = async (search: ServerSearch): Promise<string | undefined> => {
  const ranked = [search.explicit, search.inherited].filter((s): s is string => s !== undefined && s !== '' && !isUnsafeSpelling(s))
  const candidates = [...new Set([...ranked, ...search.sockets])]
  const answers = await Promise.all(candidates.map(server => search.cwdOf(server).catch(() => undefined)))
  const cwdOf = new Map(candidates.map((server, i) => [server, answers[i]]))
  for (const server of ranked) if (cwdOf.get(server) !== undefined) return server
  const wanted = new Set(search.projectDirs.map(dir => dir.replace(/\/+$/, '')))
  for (const socket of search.sockets) {
    const cwd = cwdOf.get(socket)
    if (cwd !== undefined && wanted.has(cwd.trim().replace(/\/+$/, ''))) return socket
  }
  return undefined
}

/** Servers that failed recently: skipped until `ttlMs` has passed, so a dead socket costs one timeout, not one per click. */
export const createFailureMemo = (ttlMs = FAILED_SERVER_TTL_MS) => {
  const failed = new Map<string, number>()
  return {
    isSkipped: (server: string, now: number) => {
      const at = failed.get(server)
      if (at === undefined) return false
      if (now - at < ttlMs) return true
      failed.delete(server)
      return false
    },
    fail: (server: string, now: number) => void failed.set(server, now),
    ok: (server: string) => void failed.delete(server),
  }
}

/** A Map that keeps at most `limit` entries, the oldest written leaving first. */
export const createBoundedCache = <V>(limit = RENDER_CACHE_LIMIT) => {
  const entries = new Map<string, V>()
  return {
    get: (key: string) => entries.get(key),
    set: (key: string, value: V) => {
      entries.delete(key)
      entries.set(key, value)
      while (entries.size > limit) entries.delete(entries.keys().next().value as string)
    },
    get size() {
      return entries.size
    },
  }
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

/** A private (0700) directory of its own for thumbnails, never a predictable shared name. */
export const privateDirArgv = (tmp: string | undefined): string[] => ['mktemp', '-d', `${(tmp || '/tmp').replace(/\/+$/, '')}/pb-file-preview.XXXXXX`]

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
