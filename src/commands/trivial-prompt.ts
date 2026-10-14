/**
 * Cheap, deterministic gate for the UserPromptSubmit hook: acknowledgements
 * and continuations ("si", "ok", "you sure?") carry no code question, but
 * still cost a retrieval + injected block on every one of them. This never
 * runs on the MCP search_context tool or the CLI `search "<q>"` — only on
 * the hook's --stdin path in commands/search.ts.
 */

/** Words that, alone or in a run of themselves, carry no content on their own. */
const FILLER_WORDS = new Set([
  // english
  "yes",
  "yep",
  "yeah",
  "no",
  "nope",
  "ok",
  "okay",
  "sure",
  "fine",
  "alright",
  "right",
  "thanks",
  "thank",
  "thx",
  "perfect",
  "great",
  "cool",
  "go",
  "on",
  "continue",
  "proceed",
  "please",
  "you",
  "pues",
  "all",
  // spanish
  "si",
  "sí",
  "no",
  "dale",
  "sale",
  "listo",
  "vale",
  "ya",
  "bueno",
  "gracias",
  "perfecto",
  "continua",
  "continúa",
  "sigue",
  "seguir",
  "entendi",
  "entiendo",
]);

const CODE_IDENTIFIER_PATTERNS = [
  /`[^`]+`/, // backticked identifier
  /\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*\b/, // camelCase
  /\b[a-z0-9]+_[a-z0-9_]+\b/, // snake_case
  /\b[\w.-]+\/[\w./-]+\b/, // a path
  /\b\w+\(/, // a call
  /^\s*at\s.+:\d+(:\d+)?\)?\s*$/m, // a stack frame
];

/** True if the prompt names a specific piece of code, even inside a short prompt. */
function hasCodeIdentifier(prompt: string): boolean {
  return CODE_IDENTIFIER_PATTERNS.some((re) => re.test(prompt));
}

/** Splits into lowercase words, dropping punctuation. */
function tokenize(prompt: string): string[] {
  return (prompt.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter(Boolean);
}

/**
 * True when the prompt is made up entirely of acknowledgement/continuation
 * words — in English or Spanish — regardless of length. A single unknown
 * word means real content, so it is never trivial. Empty/whitespace-only
 * prompts tokenize to zero words, which vacuously satisfies "every word is
 * filler" and stays trivial. A prompt naming a code identifier is never
 * trivial, even when every other word is filler.
 */
export function isTrivialPrompt(prompt: string): boolean {
  if (hasCodeIdentifier(prompt)) return false;

  return tokenize(prompt).every((w) => FILLER_WORDS.has(w));
}

/** Action verbs that, next to filler, still say nothing about code ("ok, commit y push"). */
const ACTION_WORDS = new Set([
  "commit", "push", "merge", "pull", "deploy", "release", "y", "and", "then", "luego", "ahora", "now",
]);

/** Prompts that start with one of these are harness output, not a question. */
const HARNESS_FRAMES = [
  "<task-notification",
  "<system-reminder",
  "<command-name>",
  "<command-message>",
  "<local-command",
  "<user-prompt-submit-hook",
  "caveat: the messages below",
  "[request interrupted",
  "base directory for this skill",
];

const MIN_WORDS = 2;

/** True when most non-empty lines are indented — a pasted log, diff or agent report. */
function isMostlyIndented(prompt: string): boolean {
  const lines = prompt.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 3) return false;
  return lines.filter((l) => /^(\s{2,}|\t)/.test(l)).length / lines.length > 0.5;
}

/**
 * Hook-only superset of {@link isTrivialPrompt}: also skips single-word prompts, filler plus a bare action verb, slash-command echoes and
 * pasted harness/agent reports. A code identifier always wins over length.
 */
export function isNonCodePrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (isTrivialPrompt(trimmed)) return true;

  const lower = trimmed.toLowerCase();
  if (trimmed.startsWith("/") && !/^\/[\w.-]+\/[\w./-]/.test(trimmed)) return true;
  if (HARNESS_FRAMES.some((f) => lower.startsWith(f))) return true;

  if (hasCodeIdentifier(trimmed)) return false;
  if (isMostlyIndented(prompt)) return true;

  const words = tokenize(trimmed);
  if (words.length < MIN_WORDS) return true;
  return words.every((w) => FILLER_WORDS.has(w) || ACTION_WORDS.has(w));
}
