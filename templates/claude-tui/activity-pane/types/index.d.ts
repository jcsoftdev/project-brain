export type CallStatus = 'running' | 'ok' | 'error' | 'denied'

export type Decision = { question: string; answer: string }

export type TestFile = { file: string; ok: boolean }

export type ToolEntry = {
  id: string
  tool: string
  summary: string
  status: CallStatus
  output: string
  startedAt: number
  durationMs?: number
  agentId?: string
  command?: string
  file?: string
  note?: string
  exitCode?: number
  testFiles?: TestFile[]
  decisions?: Decision[]
  spawned?: string
}

export type Tab = 'summary' | 'commands' | 'diff'

export type AgentState = 'running' | 'done' | 'failed'

export type AgentRecord = {
  id: string
  description: string
  type: string
  name?: string
  state: AgentState
  startedAt: number
}

export type PaneScroll = { offset: number; follow: boolean }

export type FileChange = { path: string; added: number; removed: number }

declare module 'claude-code' {
  interface PluginState {
    'project-brain-activity': {
      entries: Shaped<ToolEntry[]>
      tabs: Shaped<Record<string, Tab>>
      toggled: Shaped<string[]>
      changes: Shaped<FileChange[]>
      costUsd: Shaped<number>
      contextPercent: Shaped<number>
      openFiles: Shaped<string[]>
      diffs: Shaped<Record<string, string>>
      agents: Shaped<AgentRecord[]>
      pickedAgent: Shaped<string>
      working: Shaped<boolean>
      scroll: Shaped<PaneScroll>
    }
  }
}
