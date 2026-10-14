/**
 * Pilot calibration for the /clear notice confidence. Replays Claude Code transcripts READ-ONLY,
 * builds labelled cases in memory, asks Jev the real task-switch question for each, and prints
 * precision/recall per confidence. Nothing from a transcript is written anywhere or printed.
 *
 *   bun scripts/calibrate-task-switch.ts [--max 30] [--files 60] [--dry]
 *
 * Labels are what the user implicitly said: a prompt that opened a session (or followed a /clear)
 * within 10 minutes of a session that ended at >= 30% context is a "new task"; a prompt typed
 * mid-session at >= 30% context is "continued". The second label is noisy (people also continue
 * unrelated work), so precision here is a lower bound on how often a notice is welcome.
 *
 * Hard cap: never more than 30 Jev requests, whatever --max says.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveRerankerToken } from "../src/rerank/token.js";
import { ask } from "../src/typesafe/client.js";
import {
  contextTokens,
  contextWindow,
  extractRecentPrompts,
  lastAssistantSummary,
  NEW_TASK,
  parseEntries,
  taskSwitchQuestion,
  type Entry,
} from "../src/hooks/task-switch.js";

const HARD_CAP = 30;
const NOTICE_PCT = 30;
const GAP_MS = 10 * 60_000;
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && Number(process.argv[i + 1]) > 0 ? Number(process.argv[i + 1]) : fallback;
};
const max = Math.min(arg("max", HARD_CAP), HARD_CAP);
const fileLimit = arg("files", 60);
const dry = process.argv.includes("--dry");

interface Case {
  label: "new" | "same";
  prompt: string;
  recent: string[];
  assistant: ReturnType<typeof lastAssistantSummary>;
  pct: number;
}
interface Session {
  entries: Array<Entry & { timestamp?: string }>;
  dir: string;
  first: number;
  last: number;
}

async function autoCompactWindow(): Promise<number | undefined> {
  try {
    const s = JSON.parse(await readFile(join(homedir(), ".claude", "settings.json"), "utf8")) as { autoCompactWindow?: unknown };
    return typeof s.autoCompactWindow === "number" ? s.autoCompactWindow : undefined;
  } catch {
    return undefined;
  }
}

const typed = (e: Entry): string | null => extractRecentPrompts([e], 1)[0] ?? null;
const at = (e: { timestamp?: string }) => Date.parse(e.timestamp ?? "") || 0;

async function loadSessions(root: string, limit: number): Promise<Session[]> {
  const files: Array<{ path: string; dir: string; mtime: number }> = [];
  for (const dir of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, dir)).catch(() => [])) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(root, dir, name);
      files.push({ path, dir, mtime: (await stat(path)).mtimeMs });
    }
  }
  const sessions: Session[] = [];
  for (const f of files.sort((a, b) => b.mtime - a.mtime).slice(0, limit)) {
    const entries = parseEntries(await readFile(f.path, "utf8")) as Session["entries"];
    const stamps = entries.map(at).filter(Boolean);
    if (stamps.length === 0) continue;
    sessions.push({ entries, dir: f.dir, first: Math.min(...stamps), last: Math.max(...stamps) });
  }
  return sessions;
}

async function buildCases(sessions: Session[]): Promise<{ cases: Case[]; positives: number; negatives: number }> {
  const window = await autoCompactWindow();
  const pctOf = (entries: Entry[]) => {
    const tokens = contextTokens(entries);
    return tokens === null ? 0 : (tokens / contextWindow(tokens, process.env, window)) * 100;
  };
  const news: Case[] = [];
  const same: Case[] = [];

  for (const s of sessions) {
    const pct = pctOf(s.entries);
    // New task: the first real prompt of a later session in the same project within 10 minutes of this one's end.
    if (pct >= NOTICE_PCT) {
      const next = sessions
        .filter((o) => o !== s && o.dir === s.dir && o.first >= s.last && o.first - s.last <= GAP_MS)
        .sort((a, b) => a.first - b.first)[0];
      const prompt = next?.entries.map(typed).find((p): p is string => p !== null);
      if (prompt) news.push({ label: "new", prompt, recent: extractRecentPrompts(s.entries, 4), assistant: lastAssistantSummary(s.entries), pct });
    }
    // Continued: a prompt typed mid-session at >= 30% context.
    for (let i = 1; i < s.entries.length; i++) {
      const prompt = typed(s.entries[i]!);
      if (prompt === null) continue;
      const before = s.entries.slice(0, i);
      const p = pctOf(before);
      if (p < NOTICE_PCT) continue;
      const recent = extractRecentPrompts(before, 4);
      if (recent.length === 0) continue;
      same.push({ label: "same", prompt, recent, assistant: lastAssistantSummary(before), pct: p });
    }
  }
  // Spread the continued cases across sessions instead of taking the first ones.
  const stride = Math.max(1, Math.floor(same.length / Math.max(1, max)));
  const pickedSame = same.filter((_, i) => i % stride === 0);
  const half = Math.floor(max / 2);
  const chosenNew = news.slice(0, half);
  const chosen = [...chosenNew, ...pickedSame.slice(0, max - chosenNew.length)];
  return { cases: chosen, positives: news.length, negatives: same.length };
}

const sessions = await loadSessions(join(homedir(), ".claude", "projects"), fileLimit);
const { cases, positives, negatives } = await buildCases(sessions);
const newCount = cases.filter((c) => c.label === "new").length;
console.log(`sessions read: ${sessions.length}; candidate cases: ${positives} new-task, ${negatives} continued; selected: ${newCount} new + ${cases.length - newCount} continued (cap ${max})`);
if (dry) process.exit(0);

const token = await resolveRerankerToken();
if (!token) {
  console.log("no TypeSafe token available: no requests made, thresholds unchanged");
  process.exit(0);
}
if (newCount < 5) console.log(`only ${newCount} labelled new-task cases: too few for a reliable threshold`);

const results: Array<{ label: Case["label"]; p: number | null }> = [];
let requests = 0;
for (const c of cases) {
  if (requests >= max) break;
  requests++;
  const state = {
    prompt: c.prompt,
    recent_prompts: c.recent,
    ...(c.assistant ? { last_assistant_turn: { text: c.assistant.text, tools_used: c.assistant.tools } } : {}),
  };
  const answers = await ask(token, state, { switch: taskSwitchQuestion() }, { timeoutMs: 8000 });
  const p = answers?.switch?.probabilities?.[NEW_TASK];
  results.push({ label: c.label, p: typeof p === "number" ? p : null });
}

const answered = results.filter((r) => r.p !== null);
console.log(`requests: ${requests}; answered: ${answered.length}`);
const positivesAnswered = answered.filter((r) => r.label === "new").length;
for (const threshold of [0.7, 0.8, 0.9]) {
  const fired = answered.filter((r) => (r.p as number) >= threshold);
  const tp = fired.filter((r) => r.label === "new").length;
  const precision = fired.length ? tp / fired.length : NaN;
  const recall = positivesAnswered ? tp / positivesAnswered : NaN;
  console.log(`confidence ${threshold}: fired ${fired.length}, true ${tp}, precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)}`);
}
