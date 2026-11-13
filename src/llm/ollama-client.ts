import { OLLAMA_HOST } from "../constants.js";
import { LlmUnavailableError, stripThinking, type LlmClient } from "./client.js";

export const OLLAMA_CONCEPT_TIMEOUT_MS = 180_000;

/** Longest concept doc a local model may write; the prompt asks for five short sections. */
const MAX_OUTPUT_TOKENS = 2048;
const MIN_NUM_CTX = 8192;
const MAX_NUM_CTX = 32768;

/**
 * Ollama otherwise runs the model at its default context and silently cuts a
 * long prompt from the front, which drops the instructions. Sized from the
 * prompt (about three characters a token for code) plus the output budget, in
 * powers of two so repeated runs reuse a loaded model instead of reloading it.
 */
export function conceptNumCtx(prompt: string): number {
  const needed = Math.ceil(prompt.length / 3) + MAX_OUTPUT_TOKENS;
  let ctx = MIN_NUM_CTX;
  while (ctx < needed && ctx < MAX_NUM_CTX) ctx *= 2;
  return ctx;
}

export interface OllamaClientOptions {
  model: string;
  host?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Generation on the bulk Ollama — the same server sync embeds through, never
 * the interactive lane, which exists so prompt-time searches do not wait.
 * Thinking is turned off: a qwen3 model would otherwise spend most of the
 * budget reasoning before writing a line of the doc.
 */
export function createOllamaClient(opts: OllamaClientOptions): LlmClient {
  const host = (opts.host ?? OLLAMA_HOST).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? OLLAMA_CONCEPT_TIMEOUT_MS;
  const doFetch = opts.fetch ?? fetch;

  const request = async (prompt: string, think: boolean | undefined): Promise<Response> => {
    try {
      return await doFetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          ...(think === undefined ? {} : { think }),
          keep_alive: "2m",
          options: { num_ctx: conceptNumCtx(prompt), num_predict: MAX_OUTPUT_TOKENS, temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`Ollama generation timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw new LlmUnavailableError(`Ollama not reachable at ${host}`);
    }
  };

  return {
    async complete(prompt: string): Promise<string> {
      let response = await request(prompt, false);
      let errorText = response.ok ? "" : await response.text();
      // A model without a thinking mode may reject the field outright.
      if (response.status === 400 && /think/i.test(errorText)) {
        response = await request(prompt, undefined);
        errorText = response.ok ? "" : await response.text();
      }
      if (response.status === 404) {
        throw new LlmUnavailableError(
          `model "${opts.model}" is not pulled on ${host} — run \`ollama pull ${opts.model}\``
        );
      }
      if (!response.ok) {
        throw new Error(`Ollama ${response.status}: ${errorText.slice(0, 200)}`);
      }
      const body = (await response.json()) as { message?: { content?: unknown } };
      const content = body.message?.content;
      if (typeof content !== "string") throw new Error("Ollama returned no message content");
      return stripThinking(content);
    },
  };
}
