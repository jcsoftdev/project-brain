import type { EmbeddingClient } from "../types.js";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 4000;
const MAX_ATTEMPTS_PER_TEXT = 3;

export interface RescueEmbedOptions {
  /**
   * Injectable sleep — tests replace this with an instant no-op so the
   * exponential backoff never actually blocks for real seconds.
   * Defaults to a real `setTimeout`-based sleep for production use.
   */
  sleeps?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Final rescue pass (ladder step 3): after the concurrent pass and the
 * sequential small-batch pass have both been tried and some chunks are still
 * unembedded, retry those chunks ONE TEXT AT A TIME (batch size 1,
 * concurrency 1) — the smallest possible unit of work, since a
 * memory-constrained Ollama backend can fail even small concurrent/batched
 * requests but reliably succeed on a single text.
 *
 * Backoff is exponential (1s -> 2s -> 4s, capped at 4s) and its state is
 * shared across the WHOLE pass, not reset per text: consecutive failures
 * keep growing the delay regardless of which chunk they belong to, and ONLY
 * a success resets the delay back to 1s. This is deliberate — the point of
 * the backoff is to stop hammering a struggling backend, and a struggling
 * backend does not care which chunk the next request is for.
 *
 * `embeddings.reset?.()` is called once before the pass starts (to bypass
 * the circuit breaker's cooldown from the prior failed passes) AND again
 * before every retry-after-backoff — otherwise the breaker could re-trip
 * mid-pass and null out every remaining single-text request instantly,
 * defeating the whole point of this rescue pass.
 *
 * Mutates `embeddedVectors` in place (sets embeddedVectors[idx] for every
 * index in `indices` that eventually succeeds). Indices that exhaust all
 * attempts are left untouched (stay null) — the caller (runSync) recomputes
 * `embedFailed` from the null count afterward.
 */
export async function rescueEmbedPass(
  embeddings: EmbeddingClient,
  texts: string[],
  indices: number[],
  embeddedVectors: (number[] | null)[],
  opts: RescueEmbedOptions = {}
): Promise<void> {
  if (indices.length === 0) return;

  const sleep = opts.sleeps ?? realSleep;

  console.warn(
    `[sync] final rescue pass: embedding ${indices.length} chunks one-by-one with backoff...`
  );
  embeddings.reset?.();

  let backoffMs = INITIAL_BACKOFF_MS;
  // True once any attempt has failed — the NEXT attempt (whether a retry of
  // the same text or the first attempt of the next text) must sleep/backoff
  // before trying again. Cleared on any success.
  let needsBackoff = false;

  for (const idx of indices) {
    let succeeded = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TEXT && !succeeded; attempt++) {
      if (needsBackoff) {
        await sleep(backoffMs);
        // Bypass the breaker cooldown before every retry-after-backoff so it
        // never starves the rescue pass mid-flight.
        embeddings.reset?.();
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }

      const vecs = await embeddings.embed([texts[idx]]);
      if (vecs && vecs[0]) {
        embeddedVectors[idx] = vecs[0];
        succeeded = true;
        backoffMs = INITIAL_BACKOFF_MS;
        needsBackoff = false;
      } else {
        needsBackoff = true;
      }
    }
    // If every attempt failed, embeddedVectors[idx] stays null — the caller
    // recomputes embedFailed from the remaining null count.
  }
}
