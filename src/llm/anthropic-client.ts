import Anthropic from "@anthropic-ai/sdk";
import { CONCEPT_LLM_MODEL } from "../constants.js";

export interface LlmClient {
  complete(prompt: string): Promise<string>;
}

/** Read per call, not at import, so `BRAIN_CONCEPT_MODEL` can be set after the module loads. */
export function resolveConceptModel(): string {
  return process.env.BRAIN_CONCEPT_MODEL?.trim() || CONCEPT_LLM_MODEL;
}

/**
 * Zero-arg client: the SDK auto-resolves credentials from whatever the host
 * already has (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login`
 * profile) — same subscription the interactive host uses, nothing to provision.
 * If no credential is available at all, `complete()` throws on first call —
 * callers (runConceptualize) already retry-then-skip on any LLM failure.
 */
export function createAnthropicClient(): LlmClient {
  const client = new Anthropic();

  return {
    async complete(prompt: string): Promise<string> {
      const response = await client.messages.create({
        model: resolveConceptModel(),
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      });
      const block = response.content[0];
      if (block.type !== "text") {
        throw new Error("Unexpected non-text response from Anthropic API");
      }
      return block.text;
    },
  };
}
