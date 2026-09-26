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
