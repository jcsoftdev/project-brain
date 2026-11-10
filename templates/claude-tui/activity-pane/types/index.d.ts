export type CallStatus = 'running' | 'ok' | 'error' | 'denied' | 'interrupted'

export type Decision = { question: string; answer: string; refused?: boolean }

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

export type CambiosScope = 'commits' | 'uncommitted' | 'branch'

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

export type FileChange = { path: string; added: number; removed: number; untracked?: boolean; binary?: boolean }

export type CommitRecord = {
  sha: string
  subject: string
  branch: string
  agentId?: string
  at: number
  isMerge?: boolean
  added?: number
  removed?: number
  files?: FileChange[]
  statsFailed?: boolean
}

export type BranchCommit = { sha: string; subject: string }

export type BranchView = {
  isLoaded: boolean
  baseRef?: string
  base?: string
  files: FileChange[]
  commits: BranchCommit[]
  error?: string
}

export type DiffRow = { gutter: string; sign: string; text: string; kind: 'add' | 'del' | 'hunk' | 'same' }

export type DiffPatch = { rows: DiffRow[]; total: number }

export type ContextUsage = { tokens?: number; window: number; percent?: number }

export type StepContext = { tokens: number; model: string }

export type EditorState = { dir: string; tab: string }

declare module 'claude-code' {
  interface PluginState {
    'project-brain-activity': {
      entries: Shaped<ToolEntry[]>
      tabs: Shaped<Record<string, Tab>>
      toggled: Shaped<string[]>
      changes: Shaped<FileChange[]>
      costUsd: Shaped<number>
      context: Shaped<ContextUsage>
      stepContext: Shaped<Record<string, StepContext>>
      openFiles: Shaped<string[]>
      diffs: Shaped<Record<string, DiffPatch>>
      agents: Shaped<AgentRecord[]>
      pickedAgent: Shaped<string>
      working: Shaped<boolean>
      scroll: Shaped<PaneScroll>
      commits: Shaped<CommitRecord[]>
      scopes: Shaped<Record<string, CambiosScope>>
      branch: Shaped<BranchView>
      autoOpen: Shaped<boolean>
      editor: Shaped<EditorState>
    }
  }
}
