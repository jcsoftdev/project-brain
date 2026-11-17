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
  model?: string
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

/** What one loop has spent across its model requests; `usd` turns null for good once a step's model has no known price. */
export type AgentUsage = { input: number; output: number; cacheWrite: number; cacheRead: number; usd: number | null }

export type SessionIdentityLine = { account: string; sessionId: string; folder: string }

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
      agentUsage: Shaped<Record<string, AgentUsage>>
      mainModel: Shaped<string>
      identity: Shaped<SessionIdentityLine>
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
      // feat:ci:start
      ciStatus: Shaped<{
        state: 'idle' | 'ready' | 'unavailable'
        reason?: string
        upstream?: string
        ahead?: number
        behind?: number
        sha?: string
        runs: {
          id: number
          workflow: string
          title: string
          status: string
          conclusion: string
          branch: string
          createdAt: string
          url: string
          jobs?: { name: string; status: string; conclusion: string; failedStep?: string }[]
        }[]
        checkedAt: number
      }>
      // feat:ci:end
      // feat:running:start
      runningTasks: Shaped<{
        id: string
        kind: 'bash' | 'monitor' | 'agent' | 'workflow'
        label: string
        status: 'running' | 'completed' | 'failed' | 'killed'
        startedAt: number
        endedAt?: number
        agentId?: string
        agentLabel?: string
        toolUseId?: string
        outputFile?: string
        lastLine?: string
        exitCode?: number
        deadline?: number
        isInferred?: boolean
      }[]>
      runningTick: Shaped<number>
      // feat:running:end
      // feat:progress:start
      progress: Shaped<{
        path: string
        mtimeMs: number
        doc?: {
          feature: string
          path: string
          title: string
          objective?: string
          tasks: { id: string; title: string; done: boolean; route?: string; commit?: string }[]
          done: number
          total: number
          current?: { id: string; title: string; done: boolean; route?: string; commit?: string }
          pending: string[]
        }
      }>
      // feat:progress:end
      // feat:agents:start
      agentsExpanded: Shaped<boolean>
      agentsReports: Shaped<Record<string, string>>
      // feat:agents:end
      // feat:context:start
      contextBreakdown: Shaped<{ rows: { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' }[]; window: number; total: number; autoCompactAt?: number; at: number }>
      contextCompactions: Shaped<{ count: number; lastAt: number; before?: number; after?: number }>
      contextLive: Shaped<{ tokens?: number; window: number; percent?: number }>
      // feat:context:end
      // feat:blocked:start
      blockedList: Shaped<{ id: string; at: number; tool: string; summary: string; category: 'user' | 'classifier' | 'rule' | 'hook'; reason: string; label?: string; agentId?: string; agent?: string }[]>
      blockedTurn: Shaped<number>
      // feat:blocked:end
      // feat:savings:start
      savings: Shaped<{
        at: number
        gate?: { count: number; chars: number; last: { at: number; event: string; chars: number; score?: number; head: string }[] }
        picks?: { prompts: { at: number; skills: string[] }[]; delegations: { agentId: string; description: string; skills: string[] }[] }
        listing?: 'jev' | 'stats' | 'passthrough'
        lane?: { state: 'up' | 'mismatch' | 'dead' | 'pending' | 'off'; reason?: string; at?: number }
      }>
      // feat:savings:end
      // feat:notify:start
      notify: Shaped<boolean>
      // feat:notify:end
    }
  }
}
