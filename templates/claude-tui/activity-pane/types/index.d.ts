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

export type Tab = 'summary' | 'commands' | 'diff' | 'history'

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

/** A commit-verb Bash call: when it ran, who ran it, and the worktree it ran in when the command named one. */
export type CommitCall = { agentId?: string; top?: string; startedAt: number; endedAt: number }

/** One line of `git log --graph`: graph glyphs alone, or a commit with its fields. */
export type HistoryRow = { graph: string; sha?: string; refs?: string[]; subject?: string; at?: number; author?: string }

export type HistoryState = 'idle' | 'loading' | 'ready' | 'error'

export type HistoryView = { state: HistoryState; rows: HistoryRow[]; more: number; loadedAt: number; error?: string }

export type HistoryFiles = { files?: FileChange[]; failed?: boolean }

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
      sessionStart: Shaped<number>
      commitCalls: Shaped<CommitCall[]>
      history: Shaped<HistoryView>
      accent: Shaped<string>
      historyFiles: Shaped<Record<string, HistoryFiles>>
    }
  }
}
