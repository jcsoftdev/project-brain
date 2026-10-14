import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
export const SAME_TASK = "same_task";

export function taskSwitchEnabled(env: Env = process.env): boolean {
  return env.PROJECT_BRAIN_TASK_SWITCH !== "0";
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

type Entry = { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown; usage?: Record<string, unknown> } };

function parseEntries(jsonl: string): Entry[] {
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
}

/**
 * What the task-switch question needs, or null when it should not be asked: disabled, no
 * transcript, no usage yet, or context still under the notice threshold (nothing to save).
 */
export async function gatherTaskContext(
  transcriptPath: string | undefined,
  prompt: string,
  env: Env = process.env,
  readWindow: () => Promise<number | undefined> = readAutoCompactWindow
): Promise<TaskContext | null> {
  if (!transcriptPath || !taskSwitchEnabled(env)) return null;
  try {
    const entries = parseEntries(await readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES));
    const tokens = contextTokens(entries);
    if (tokens === null) return null;
    const usedPct = (tokens / contextWindow(tokens, env, await readWindow())) * 100;
    if (usedPct < thresholdsFrom(env).noticePct) return null;
    const recent = extractRecentPrompts(entries, RECENT_PROMPTS + 1).filter((p) => p !== prompt.trim()).slice(-RECENT_PROMPTS);
    return recent.length === 0 ? null : { recent, usedPct };
  } catch {
    return null;
  }
}

export function taskSwitchQuestion(): ChoiceQuestion {
  return {
    type: "choice",
    instructions:
      "Does `prompt` start a new task unrelated to the work in `recent_prompts`, or continue that work (a follow-up, a fix, a question about it, or a step of the same goal)? Pick new_task only when the subject clearly changed.",
    criteria: {
      [NEW_TASK]: "The prompt is about a different goal, feature or topic than the recent prompts; nothing in them is needed to answer it.",
      [SAME_TASK]: "The prompt continues, refines or asks about the work in the recent prompts.",
    },
  };
}

export type TaskSwitchVerdict = "clear" | "compact" | "none";

/** `probabilities` is Jev's answer to {@link taskSwitchQuestion}; missing or malformed means no verdict. */
export function decideTaskSwitch(
  usedPct: number,
  probabilities: Record<string, number> | undefined,
  thresholds: TaskSwitchThresholds = thresholdsFrom()
): TaskSwitchVerdict {
  if (usedPct < thresholds.noticePct || !probabilities) return "none";
  const newTask = probabilities[NEW_TASK];
  if (typeof newTask !== "number") return "none";
  if (newTask >= thresholds.newTaskConfidence) return "clear";
  return usedPct >= thresholds.compactPct && newTask < 0.5 ? "compact" : "none";
}

export function taskSwitchMessage(verdict: TaskSwitchVerdict, usedPct: number): string | null {
  const pct = Math.round(usedPct);
  if (verdict === "clear")
    return `project-brain: this looks like a new task and the context is ${pct}% full. Running /clear and resending would save context.`;
  if (verdict === "compact") return `project-brain: the context is ${pct}% full. Consider /compact before continuing.`;
  return null;
}
