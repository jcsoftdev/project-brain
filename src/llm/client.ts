export interface LlmClient {
  complete(prompt: string): Promise<string>;
}

/**
 * The backend cannot answer at all: no credentials, no model pulled, no `claude`
 * on PATH, a quota hit, or Ollama busy past the hook's wait. Retrying the next
 * module would fail the same way, so `runConceptualize` skips every remaining
 * module with one line instead of one failure per module.
 */
export class LlmUnavailableError extends Error {
  override name = "LlmUnavailableError";
}

/** Drops `<think>…</think>` blocks, and an unterminated one that runs to the end. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}
