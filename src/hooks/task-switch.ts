import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { featureEnabled } from "../features.js";
import type { ChoiceQuestion } from "../typesafe/client.js";

type Env = Record<string, string | undefined>;

/** Bytes read from the end of the transcript: enough for the last few prompts and the latest usage, never the whole file. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
export const RECENT_PROMPTS = 4;
export const PROMPT_CHARS = 300;

export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Window assumed once the transcript already holds more than the configured one: the 1M-context models. */
const LARGE_CONTEXT_WINDOW = 1_000_000;

export const DEFAULT_NOTICE_PCT = 30;
export const DEFAULT_COMPACT_PCT = 75;
/** Probability of "new task" needed before the user is told to /clear. A wrong notice costs a glance, a missed one a long context. */
export const DEFAULT_NEW_TASK_CONFIDENCE = 0.8;

export const NEW_TASK = "new_task";
export const RELATED_TASK = "related_task";
export const SAME_TASK = "same_task";
/** Probability of "related task" (the argmax) needed to suggest a focused /compact. */
export const RELATED_CONFIDENCE = 0.6;
export const ASSISTANT_CHARS = 400;
export const RECENT_TOOLS = 5;
export const FOCUS_CHARS = 60;

export function taskSwitchEnabled(env: Env = process.env, dataDir?: string): boolean {
  return featureEnabled("task-switch", dataDir, env);
}

function numberFrom(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export interface TaskSwitchThresholds {
  noticePct: number;
  compactPct: number;
  newTaskConfidence: number;
}

export function thresholdsFrom(env: Env = process.env): TaskSwitchThresholds {
  return {
    noticePct: numberFrom(env.PROJECT_BRAIN_TASK_SWITCH_PCT, DEFAULT_NOTICE_PCT, 1, 100),
    compactPct: numberFrom(env.PROJECT_BRAIN_COMPACT_PCT, DEFAULT_COMPACT_PCT, 1, 100),
    newTaskConfidence: numberFrom(env.PROJECT_BRAIN_TASK_SWITCH_CONFIDENCE, DEFAULT_NEW_TASK_CONFIDENCE, 0.5, 1),
  };
}

/** Last `maxBytes` of a file as text, dropping the partial line the cut may have started in. */
async function readTail(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    await handle.close();
  }
}

export type Entry = {
  type?: string;
  operation?: string;
  content?: unknown;
  isMeta?: boolean;
  isSidechain?: boolean;
  toolUseResult?: unknown;
  message?: { content?: unknown; usage?: Record<string, unknown> };
};

export function parseEntries(jsonl: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null) entries.push(parsed as Entry);
    } catch {
      // A truncated or foreign line is skipped, not fatal.
    }
  }
  return entries;
}

/** The text the user typed in one entry; null for tool results, meta entries, slash-command echoes and sub-agent traffic. */
function typedPrompt(entry: Entry): string | null {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return null;
  const content = entry.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n")
        : "";
  const trimmed = text.trim();
  return trimmed === "" || trimmed.startsWith("<") ? null : trimmed;
}

/** The last `count` typed prompts, oldest first, each cut to {@link PROMPT_CHARS}. */
export function extractRecentPrompts(entries: Entry[], count = RECENT_PROMPTS): string[] {
  const prompts: string[] = [];
  for (const entry of entries) {
    const text = typedPrompt(entry);
    if (text !== null) prompts.push(text.length <= PROMPT_CHARS ? text : `${text.slice(0, PROMPT_CHARS - 1).trimEnd()}…`);
  }
  return prompts.slice(-count);
}

/** Tokens in the context after the most recent assistant message: input + cache creation + cache reads. Null when there is none. */
export function contextTokens(entries: Entry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== "assistant" || entry.isSidechain) continue;
    const usage = entry.message?.usage;
    if (!usage) continue;
    const total = (["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const).reduce(
      (sum, key) => sum + (typeof usage[key] === "number" ? (usage[key] as number) : 0),
      0
    );
    if (total > 0) return total;
  }
  return null;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "killed", "stopped"]);

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b) => (b && typeof b === "object" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n")
      : "";

/** A tool result that says the work went to the background rather than finishing. */
function launchedInBackground(entry: Entry, resultText: string): boolean {
  const r = entry.toolUseResult;
  if (r && typeof r === "object" && !Array.isArray(r)) {
    const o = r as Record<string, unknown>;
    if (o.isAsync === true || typeof o.backgroundTaskId === "string") return true;
  }
  return /running in background|async agent launched|workflow (started|launched|is running)/i.test(resultText);
}

const taskIdOf = (entry: Entry): string | null => {
  const r = entry.toolUseResult;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const o = r as Record<string, unknown>;
  const id = typeof o.agentId === "string" ? o.agentId : typeof o.backgroundTaskId === "string" ? o.backgroundTaskId : null;
  return id;
};

/**
 * Whether work is still in flight in the main thread: a tool call with no result yet, or something
 * launched in the background (Agent, Bash or Workflow) that has not reported back. A launch result
 * carries `agentId` or `backgroundTaskId`; completion arrives as a `<task-notification>` (a user
 * entry and/or a `queue-operation` enqueue) naming the launching call in `<tool-use-id>` and the task
 * in `<task-id>`, with a terminal `<status>`. A `TaskStop` call ends its task too. Either id matches.
 * Sub-agent traffic lives in other files and is skipped here.
 */
export function hasPendingWork(entries: Entry[]): boolean {
  const open = new Set<string>();
  /** Launching tool_use id -> task id (when the result gave one). */
  const background = new Map<string, string | null>();
  const finish = (id: string) => {
    open.delete(id);
    for (const [toolUseId, taskId] of background) if (toolUseId === id || taskId === id) background.delete(toolUseId);
  };
  const settle = (text: string) => {
    for (const note of text.matchAll(/<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g)) {
      const status = /<status>([^<]+)<\/status>/.exec(note[1]!)?.[1]?.trim();
      if (!status || !TERMINAL_STATUSES.has(status)) continue;
      for (const tag of ["tool-use-id", "task-id"]) {
        const id = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(note[1]!)?.[1]?.trim();
        if (id) finish(id);
      }
    }
  };
  for (const entry of entries) {
    if (entry.isSidechain) continue;
    if (entry.type === "queue-operation") {
      if (entry.operation === "enqueue" && typeof entry.content === "string") settle(entry.content);
      continue;
    }
    const content = entry.message?.content;
    if (entry.type === "assistant" && Array.isArray(content)) {
      for (const b of content as Array<{ type?: string; id?: string; name?: string; input?: { task_id?: unknown } }>) {
        if (b?.type !== "tool_use") continue;
        if (b.name === "TaskStop" && typeof b.input?.task_id === "string") finish(b.input.task_id);
        if (b.id) open.add(b.id);
      }
    } else if (entry.type === "user") {
      settle(textOf(content));
      if (!Array.isArray(content)) continue;
      for (const b of content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
        if (b?.type !== "tool_result" || !b.tool_use_id) continue;
        open.delete(b.tool_use_id);
        if (launchedInBackground(entry, textOf(b.content))) background.set(b.tool_use_id, taskIdOf(entry));
        else background.delete(b.tool_use_id);
      }
    }
  }
  return open.size > 0 || background.size > 0;
}

export interface AssistantSummary {
  /** The last assistant text block, cut to {@link ASSISTANT_CHARS}. */
  text: string;
  /** Names of the most recent tools used, newest last. Never their inputs or outputs. */
  tools: string[];
}

/** What the assistant last said and which tools it reached for; null when it has said nothing yet. */
export function lastAssistantSummary(entries: Entry[]): AssistantSummary | null {
  let text: string | null = null;
  const tools: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== "assistant" || entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
    const blocks = entry.message!.content as Array<{ type?: string; text?: unknown; name?: unknown }>;
    if (text === null) {
      const last = [...blocks].reverse().find((b) => b?.type === "text" && String(b.text ?? "").trim() !== "");
      if (last) {
        const t = String(last.text).trim().replace(/\s+/g, " ");
        text = t.length <= ASSISTANT_CHARS ? t : `${t.slice(0, ASSISTANT_CHARS - 1).trimEnd()}…`;
      }
    }
    for (const b of [...blocks].reverse()) {
      if (b?.type === "tool_use" && typeof b.name === "string" && tools.length < RECENT_TOOLS && !tools.includes(b.name)) tools.push(b.name);
    }
    if (text !== null && tools.length >= RECENT_TOOLS) break;
  }
  if (text === null && tools.length === 0) return null;
  return { text: text ?? "", tools: tools.reverse() };
}

/** The new prompt's opening as a single safe line for a `/compact focus on:` hint. */
export function focusHint(prompt: string): string {
  const line = prompt.replace(/[\u0000-\u001f\u007f`]/g, " ").replace(/\s+/g, " ").trim();
  return line.length <= FOCUS_CHARS ? line : line.slice(0, FOCUS_CHARS).trimEnd();
}

/**
 * The window usage is measured against: the env override, else the auto-compact window setup wrote
 * (that is where Claude Code compacts, so it is the limit the user feels), else 200K. A transcript
 * already past that belongs to a 1M-context model.
 */
export function contextWindow(tokens: number, env: Env = process.env, autoCompactWindow?: number): number {
  const override = Number(env.PROJECT_BRAIN_CONTEXT_WINDOW);
  const configured = Number.isFinite(override) && override > 0 ? override : autoCompactWindow && autoCompactWindow > 0 ? autoCompactWindow : DEFAULT_CONTEXT_WINDOW;
  return tokens > configured && !(Number.isFinite(override) && override > 0) ? Math.max(LARGE_CONTEXT_WINDOW, configured) : configured;
}

async function readAutoCompactWindow(): Promise<number | undefined> {
  try {
    const settings = JSON.parse(await readFile(join(homedir(), ".claude", "settings.json"), "utf8")) as { autoCompactWindow?: unknown };
    return typeof settings.autoCompactWindow === "number" ? settings.autoCompactWindow : undefined;
  } catch {
    return undefined;
  }
}

export interface TaskContext {
  /** Prompts before the new one, oldest first. */
  recent: string[];
  /** Used share of the context window, 0-100. */
  usedPct: number;
  /** Work still in flight (a background agent or task, or a call without its result): never suggest /clear. */
  pending: boolean;
  /** The last assistant turn in brief; only gathered once the context is over the notice threshold. */
  assistant: AssistantSummary | null;
}

/**
 * What the task-switch question needs, or null when it should not be asked: disabled, no
 * transcript, no usage yet, or context still under the notice threshold (nothing to save).
 */
export async function gatherTaskContext(
  transcriptPath: string | undefined,
  prompt: string,
  env: Env = process.env,
  readWindow: () => Promise<number | undefined> = readAutoCompactWindow,
  dataDir?: string
): Promise<TaskContext | null> {
  if (!transcriptPath || !taskSwitchEnabled(env, dataDir)) return null;
  try {
    const entries = parseEntries(await readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES));
    const tokens = contextTokens(entries);
    if (tokens === null) return null;
    const usedPct = (tokens / contextWindow(tokens, env, await readWindow())) * 100;
    if (usedPct < thresholdsFrom(env).noticePct) return null;
    const recent = extractRecentPrompts(entries, RECENT_PROMPTS + 1).filter((p) => p !== prompt.trim()).slice(-RECENT_PROMPTS);
    return recent.length === 0 ? null : { recent, usedPct, pending: hasPendingWork(entries), assistant: lastAssistantSummary(entries) };
  } catch {
    return null;
  }
}

export function taskSwitchQuestion(): ChoiceQuestion {
  return {
    type: "choice",
    instructions:
      "Compare `prompt` with `recent_prompts` and `last_assistant_turn` (what the assistant last said and the tools it used). " +
      "Pick new_task only when the subject clearly changed and nothing earlier is needed; related_task when it is a different task but part of the earlier context would still help; same_task when it continues that work (a follow-up, a fix, a question about it, or a step of the same goal).",
    criteria: {
      [NEW_TASK]: "The prompt is about a different goal, feature or topic; nothing in the earlier work is needed to answer it.",
      [RELATED_TASK]: "The prompt is a different task, but some of the earlier context (files, decisions, findings) would still be useful for it.",
      [SAME_TASK]: "The prompt continues, refines or asks about the work in the recent prompts.",
    },
  };
}

export type TaskSwitchVerdict = "clear" | "compact" | "compact-focus" | "none";

/**
 * `probabilities` is Jev's answer to {@link taskSwitchQuestion}; missing or malformed means no verdict.
 * While work is in flight a /clear would throw it away, so that verdict degrades to /compact once
 * the context is past the compact threshold and to nothing before.
 */
export function decideTaskSwitch(
  usedPct: number,
  probabilities: Record<string, number> | undefined,
  thresholds: TaskSwitchThresholds = thresholdsFrom(),
  pending = false
): TaskSwitchVerdict {
  if (usedPct < thresholds.noticePct || !probabilities) return "none";
  const newTask = probabilities[NEW_TASK];
  if (typeof newTask !== "number") return "none";
  const overCompact = usedPct >= thresholds.compactPct;
  if (newTask >= thresholds.newTaskConfidence) return pending ? (overCompact ? "compact" : "none") : "clear";
  const related = probabilities[RELATED_TASK];
  const same = probabilities[SAME_TASK];
  if (typeof related === "number" && related >= RELATED_CONFIDENCE && related > newTask && related >= (typeof same === "number" ? same : 0)) return "compact-focus";
  return overCompact && newTask < 0.5 ? "compact" : "none";
}

/** `prompt` supplies the focus hint of a "compact-focus" notice. */
export function taskSwitchMessage(verdict: TaskSwitchVerdict, usedPct: number, prompt = ""): string | null {
  const pct = Math.round(usedPct);
  if (verdict === "clear")
    return `project-brain: this looks like a new task and the context is ${pct}% full. Running /clear and resending would save context.`;
  if (verdict === "compact-focus") {
    const hint = focusHint(prompt);
    return `project-brain: this is a different task but part of the earlier context still helps, and the context is ${pct}% full. Consider /compact${hint ? ` focus on: ${hint}` : ""}.`;
  }
  if (verdict === "compact") return `project-brain: the context is ${pct}% full. Consider /compact before continuing.`;
  return null;
}

/**
 * Whether this is the first `kind` notice of the session, recording it when so. One small file per
 * session, so concurrent sessions never share a write; a failure to record shows the notice again
 * rather than hiding it.
 */
export async function claimNotice(dataDir: string, sessionId: string, kind: "clear" | "compact"): Promise<boolean> {
  const file = join(dataDir, "task-switch", `${sessionId.replace(/[^\w-]/g, "_")}.json`);
  try {
    const shown = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    if (shown[kind] === true) return false;
    await writeFile(file, JSON.stringify({ ...shown, [kind]: true }));
  } catch {
    try {
      await mkdir(join(dataDir, "task-switch"), { recursive: true });
      await writeFile(file, JSON.stringify({ [kind]: true }));
    } catch {
      // Unrecorded: the notice may repeat, which beats losing it.
    }
  }
  return true;
}
