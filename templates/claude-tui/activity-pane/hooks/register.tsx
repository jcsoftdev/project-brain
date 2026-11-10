import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CallStatus, FileChange, Tab, ToolEntry } from '../types'

const PANE = 'activity'
const WIDEST = 1000
const KEEP = 200
const OUTPUT_LINES = 12
const SUMMARY_FIELDS = ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'] as const
const COMMAND_TOOLS = new Set(['Bash'])
const CHANGE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

const entries = atom({ plugin: 'project-brain-activity', key: 'entries' } as const, [], { shape: 'entries-2' })
const tab = atom({ plugin: 'project-brain-activity', key: 'tab' } as const, 'all' as Tab, { shape: 'tab-1' })
const toggled = atom({ plugin: 'project-brain-activity', key: 'toggled' } as const, [] as string[], { shape: 'toggled-1' })
const changes = atom({ plugin: 'project-brain-activity', key: 'changes' } as const, [] as FileChange[], { shape: 'changes-1' })
const openFiles = atom({ plugin: 'project-brain-activity', key: 'openFiles' } as const, [] as string[], { shape: 'open-files-1' })
const diffs = atom({ plugin: 'project-brain-activity', key: 'diffs' } as const, {} as Record<string, string>, { shape: 'diffs-1' })
const DIFF_LINES = 120

type DiffRow = { gutter: string; sign: string; text: string; kind: 'add' | 'del' | 'hunk' | 'same' }

const diffRows = (patch: string): DiffRow[] => {
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
    const text = raw.slice(1)
    if (sign === '+') rows.push({ gutter: String(newLine++), sign: '+', text, kind: 'add' })
    else if (sign === '-') rows.push({ gutter: String(oldLine++), sign: '-', text, kind: 'del' })
    else if (sign === ' ') { rows.push({ gutter: String(newLine), sign: ' ', text, kind: 'same' }); oldLine++; newLine++ }
  }
  return rows
}

const costUsd = atom({ plugin: 'project-brain-activity', key: 'costUsd' } as const, 0, { shape: 'cost-1' })

const dollars = (usd: number): string => `~$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

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

const STATUS_LOOK: Record<CallStatus, { dot: string; color: 'warning' | 'success' | 'error' | 'subtle' }> = {
  running: { dot: '◌', color: 'warning' },
  ok: { dot: '●', color: 'success' },
  error: { dot: '●', color: 'error' },
  denied: { dot: '○', color: 'subtle' },
}

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-_]/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g
const clean = (text: string): string => text.replace(ANSI, '').replace(/\t/g, '  ').replace(CONTROL, '')

const summarize = (input: Record<string, unknown>): string => {
  const field = SUMMARY_FIELDS.find(name => typeof input[name] === 'string' && input[name] !== '')
  const raw = field ? String(input[field]) : JSON.stringify(input)
  return clean(raw).replace(/\s+/g, ' ').trim().slice(0, 200)
}

const tail = (text: string | undefined): string =>
  clean(text ?? '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line !== '')
    .slice(-OUTPUT_LINES)
    .map(line => line.slice(0, 200))
    .join('\n')

const clockTime = (epochMs: number): string => new Date(epochMs).toTimeString().slice(0, 8)

const seconds = (ms: number | undefined): string => (ms === undefined ? '' : `${(ms / 1000).toFixed(1)} s`)

const titleOf = (tool: string): string => TITLES[tool] ?? (tool.startsWith('mcp__') ? `MCP · ${tool.split('__').pop()}` : tool)

const testBadge = (output: string): string | undefined => {
  const passed = /(\d+)\s+(?:pass(?:ed)?|passing)\b/i.exec(output)?.[1]
  const failed = /(\d+)\s+(?:fail(?:ed)?|failing)\b/i.exec(output)?.[1]
  if (passed === undefined && failed === undefined) return undefined
  if (failed !== undefined && failed !== '0') return `${failed} pruebas fallaron`
  return `${passed} pruebas correctas`
}

const parseNumstat = (stdout: string): FileChange[] =>
  stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter(parts => parts.length === 3)
    .map(([added, removed, path]) => ({ path: path ?? '', added: Number(added) || 0, removed: Number(removed) || 0 }))

const inTab = (entry: ToolEntry, current: Tab): boolean =>
  current === 'all' || (current === 'commands' ? COMMAND_TOOLS.has(entry.tool) : CHANGE_TOOLS.has(entry.tool))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'activity', description: 'Abre el panel de actividad' })
    void $.ui.open({ id: PANE, title: 'Actividad', columns: WIDEST })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.cost !== undefined) await update($, costUsd, () => e.cost?.usd ?? 0)
    return next(e)
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

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const entry: ToolEntry = {
      id: e.tool_use_id,
      tool: e.tool,
      summary: summarize(e as unknown as Record<string, unknown>),
      status: 'running',
      output: '',
      startedAt,
    }
    await update($, entries, list => [...list, entry].slice(-KEEP))

    const ran = await next(e)
    const durationMs = (await $.clock.now()) - startedAt
    const status: CallStatus = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'ok'
    const output = tail(ran.deny ?? ran.text)
    await update($, entries, list =>
      list.map(one => (one.id === entry.id ? { ...one, status, output, durationMs } : one)),
    )

    if (COMMAND_TOOLS.has(e.tool) || CHANGE_TOOLS.has(e.tool)) {
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [list, current, flipped, files, usd, opened, patches] = await Promise.all([read($, entries), read($, tab), read($, toggled), read($, changes), read($, costUsd), read($, openFiles), read($, diffs)])
    const toggleFile = (path: string) => async () => {
      const isOpenNow = opened.includes(path)
      if (!isOpenNow) {
        const diff = await $.process.run(['git', 'diff', '--no-color', '--no-ext-diff', 'HEAD', '--', path]).catch(() => undefined)
        await update($, diffs, all => ({ ...all, [path]: diff?.exitCode === 0 ? diff.stdout : '' }))
      }
      await update($, openFiles, paths => (isOpenNow ? paths.filter(one => one !== path) : [...paths, path]))
    }
    const rows = e.viewport?.rows ?? 30
    const lastId = list.at(-1)?.id
    const isOpen = (entry: ToolEntry): boolean => (entry.id === lastId) !== flipped.includes(entry.id)
    const toggle = (id: string) => () => void update($, toggled, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))
    const pick = (next: Tab) => () => void update($, tab, () => next)

    const commandCount = list.filter(entry => COMMAND_TOOLS.has(entry.tool)).length
    const totalMs = list.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0)

    const tabButton = (value: Tab, label: string) => (
      <Button key={`tab-${value}`} variant={current === value ? 'primary' : undefined} onPress={pick(value)}>
        {label}
      </Button>
    )

    const card = (entry: ToolEntry) => {
      const look = STATUS_LOOK[entry.status]
      const open = isOpen(entry)
      const badge = entry.status === 'running' ? undefined : testBadge(entry.output)
      return (
        <Box key={entry.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={look.color}>{look.dot}</Text>
            <Text dimColor>{clockTime(entry.startedAt)}</Text>
            <Button key={`toggle-${entry.id}`} onPress={toggle(entry.id)}>
              {open ? '▾' : '▸'} {titleOf(entry.tool)}
            </Button>
            <Text dimColor>{entry.status === 'running' ? 'corriendo…' : seconds(entry.durationMs)}</Text>
          </Box>
          <Box borderStyle="round" borderColor={look.color} flexDirection="column" paddingX={1}>
            <Text wrap="truncate-end">{entry.summary}</Text>
            {open && entry.output !== '' && <Text dimColor>{entry.output}</Text>}
            {open && entry.status === 'ok' && <Text color="success">✓ {badge ?? 'Completado'}</Text>}
            {open && entry.status === 'error' && <Text color="error">✗ {badge ?? 'Falló'}</Text>}
            {open && entry.status === 'denied' && <Text color="subtle">⊘ Bloqueado</Text>}
          </Box>
        </Box>
      )
    }

    const changesView = (
      <Box flexDirection="column">
        {files.length === 0 && <Text dimColor>Sin cambios sin commitear.</Text>}
        {files.map(file => {
          const isOpenFile = opened.includes(file.path)
          const rows = isOpenFile ? diffRows(patches[file.path] ?? '') : []
          const width = Math.max(3, ...rows.map(row => row.gutter.length))
          return (
            <Box key={file.path} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Button key={`file-${file.path}`} onPress={() => void toggleFile(file.path)()}>
                  {isOpenFile ? '▾' : '▸'} {file.path}
                </Button>
                <Text>
                  <Text color="success">+{file.added}</Text> <Text color="error">−{file.removed}</Text>
                </Text>
              </Box>
              {isOpenFile && (
                <Box flexDirection="column" borderStyle="single" borderColor="subtle" paddingX={1}>
                  {rows.length === 0 && <Text dimColor>Sin diferencias contra HEAD.</Text>}
                  {rows.slice(0, DIFF_LINES).map(row =>
                    row.kind === 'hunk' ? (
                      <Text color="suggestion" wrap="truncate-end">{row.sign} {row.text}</Text>
                    ) : (
                      <Text wrap="truncate-end">
                        <Text dimColor>{row.gutter.padStart(width)} │</Text>
                        <Text color={row.kind === 'add' ? 'diffAdded' : row.kind === 'del' ? 'diffRemoved' : undefined}>
                          {row.sign} {row.text}
                        </Text>
                      </Text>
                    ),
                  )}
                  {rows.length > DIFF_LINES && <Text dimColor>… {rows.length - DIFF_LINES} líneas más</Text>}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )

    const shown = list.filter(entry => inTab(entry, current))
    const room = Math.max(2, Math.floor((rows - 6) / 4))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} marginBottom={1}>
          {tabButton('all', 'Todo')}
          {tabButton('commands', 'Comandos')}
          {tabButton('changes', 'Cambios')}
        </Box>
        {current === 'changes'
          ? changesView
          : shown.length === 0
            ? <Text dimColor>Sin actividad todavía.</Text>
            : <Box flexDirection="column">{shown.slice(-room).map(card)}</Box>}
        <Text dimColor>
          {files.length} archivos · {commandCount} comandos · {seconds(totalMs) || '0.0 s'} · {dollars(usd)} estimado
        </Text>
      </Box>
    )
  })
}
