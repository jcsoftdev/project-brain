import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { resolveRerankerToken } from "../rerank/token.js";
import { ask, type NoulQuestion, type TypesafeFetchFn } from "../typesafe/client.js";

export const CONTEXT_KEEP_THRESHOLD = 0.5;

export const CONTEXT_JEV_TIMEOUT_MS = 1500;

export const MAX_SEGMENT_CHARS = 1200;
export const MAX_PROMPT_CHARS = 2000;
export const MAX_SEGMENTS = 8;

export const CONTEXT_GATE_HEALTH_FILE = "context-gate-health.json";

export interface ContextInput {
  prompt: string;
  segments: string[];
}

export interface ContextVerdict {
  
  keep: boolean[];
  scores: Array<number | null>;
}

export function parseContextInput(raw: string): ContextInput | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj.prompt !== "string" || !Array.isArray(obj.segments)) return null;
    const segments = obj.segments.filter((s): s is string => typeof s === "string");
    if (segments.length !== obj.segments.length) return null;
    return { prompt: obj.prompt, segments };
  } catch {
    return null;
  }
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

export const contextQuestionKey = (index: number): string => `context_${index}`;

function contextQuestion(index: number): NoulQuestion {
  return {
    type: "noul",
    instructions:
      `A tool injected \`contexts.${index}\` into the assistant's conversation. The assistant needs it to do the work \`prompt\` asks for: ` +
      "it states a rule, fact or instruction that applies to that work or to how the assistant must behave in it. " +
      "Context about an unrelated product, system or procedure is not needed.",
  };
}

export interface ContextJudgeDeps {
  getToken?: () => Promise<string | null>;
  fetchFn?: TypesafeFetchFn;
  timeoutMs?: number;
  recordHealth?: (ok: boolean) => Promise<unknown>;
}

export async function judgeContext(input: ContextInput, deps: ContextJudgeDeps = {}): Promise<ContextVerdict | null> {
  const asked = input.segments.slice(0, MAX_SEGMENTS);
  if (!input.prompt.trim() || asked.length === 0) return null;
  const token = await (deps.getToken ?? (() => resolveRerankerToken()))();
  if (!token) return null;

  const questions: Record<string, NoulQuestion> = {};
  asked.forEach((_, index) => (questions[contextQuestionKey(index)] = contextQuestion(index)));
  const state = { prompt: clip(input.prompt, MAX_PROMPT_CHARS), contexts: asked.map((s) => clip(s, MAX_SEGMENT_CHARS)) };
  const answers = await ask(token, state, questions, { fetchFn: deps.fetchFn, timeoutMs: deps.timeoutMs ?? CONTEXT_JEV_TIMEOUT_MS });
  await deps.recordHealth?.(answers !== null).catch(() => undefined);
  if (!answers) return null;

  const scores = input.segments.map((_, index) => (index < asked.length ? answers[contextQuestionKey(index)]!.noul : null));
  return { scores, keep: scores.map((score) => score === null || score >= CONTEXT_KEEP_THRESHOLD) };
}

function failuresIn(text: string): number {
  try {
    const raw = JSON.parse(text) as { failures?: unknown };
    return typeof raw.failures === "number" ? raw.failures : 0;
  } catch {
    return 0;
  }
}

export async function recordContextGateHealth(dataDir: string, ok: boolean, now: number = Date.now()): Promise<void> {
  const path = join(dataDir, CONTEXT_GATE_HEALTH_FILE);
  const failures = await readFile(path, "utf8").then(failuresIn, () => 0);
  const next = ok ? { failures: 0, lastSuccess: now } : { failures: failures + 1, lastFailure: now };
  await writeFileAtomic(path, `${JSON.stringify(next)}\n`);
}
