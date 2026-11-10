export type CallStatus = 'running' | 'ok' | 'error' | 'denied'

export type ToolEntry = {
  id: string
  tool: string
  summary: string
  status: CallStatus
  output: string
  startedAt: number
  durationMs?: number
}

export type Tab = 'all' | 'commands' | 'changes'

export type FileChange = { path: string; added: number; removed: number }

declare module 'claude-code' {
  interface PluginState {
    'project-brain-activity': {
      entries: Shaped<ToolEntry[]>
      tab: Shaped<Tab>
      toggled: Shaped<string[]>
      changes: Shaped<FileChange[]>
      costUsd: Shaped<number>
      openFiles: Shaped<string[]>
      diffs: Shaped<Record<string, string>>
    }
  }
}
