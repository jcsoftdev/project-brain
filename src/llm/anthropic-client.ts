import Anthropic from "@anthropic-ai/sdk";
import { CONCEPT_LLM_MODEL } from "../constants.js";
import { LlmUnavailableError, type LlmClient } from "./client.js";

export type { LlmClient } from "./client.js";

/** Read per call, not at import, so `BRAIN_CONCEPT_MODEL` can be set after the module loads. */
export function resolveConceptModel(): string {
  return process.env.BRAIN_CONCEPT_MODEL?.trim() || CONCEPT_LLM_MODEL;
}

const MISSING_CREDENTIALS = /authentication|api[ _-]?key|auth[ _-]?token|credential/i;

/**
 * Zero-arg client: the SDK auto-resolves credentials from whatever the host
 * already has (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login`
 * profile). With none at all, `complete()` throws `LlmUnavailableError`, and
 * runConceptualize skips the commit's modules with one line.
 */
export function createAnthropicClient(model: string = resolveConceptModel()): LlmClient {
  let client: Anthropic | null = null;

  return {
    async complete(prompt: string): Promise<string> {
      try {
        client ??= new Anthropic();
        const response = await client.messages.create({
          model,
          max_tokens: 1500,
          messages: [{ role: "user", content: prompt }],
        });
        const block = response.content[0];
        if (block.type !== "text") {
          throw new Error("Unexpected non-text response from Anthropic API");
        }
        return block.text;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof Anthropic.AuthenticationError || MISSING_CREDENTIALS.test(message)) {
          throw new LlmUnavailableError(`no usable Anthropic credentials (${message.split("\n")[0]})`);
        }
        throw err;
      }
    },
  };
}
