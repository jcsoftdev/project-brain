import { RERANK_TIMEOUT_MS } from "../constants.js";

/** One item eligible for reranking: enough for Jev to judge relevance without shipping the whole chunk. */
export interface RerankCandidate {
  file: string;
  symbol?: string;
  content: string;
}

/**
 * Reranker contract — returns null on ANY failure (timeout, non-2xx, malformed
 * body, missing answer) so callers can fall back to the unreranked pool rather
 * than partially reorder it.
 */
export interface Reranker {
  rerank(query: string, candidates: RerankCandidate[]): Promise<number[] | null>;
}

/** Injectable fetch-like function — matches src/embeddings/factory.ts's DI pattern so tests never stub global fetch. */
export type JevFetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface JevRerankerOptions {
  /** Injectable HTTP call. Defaults to the real global fetch. */
  fetchFn?: JevFetchFn;
  /** Per-request timeout, ms. Defaults to RERANK_TIMEOUT_MS. */
  timeoutMs?: number;
}

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

/** Content is capped per candidate to keep the request small and the cost bounded. */
const MAX_CONTENT_CHARS = 1200;

/**
 * TypeSafe Jev-backed reranker: one POST per search, scoring every candidate
 * with a single `noul` (0..1 relevance) question against the query.
 *
 * Never throws — any failure (network error, timeout, non-2xx, unparseable
 * body, or a missing/non-numeric answer for any candidate) resolves to null,
 * which callers treat as "leave the pool exactly as it was". Partial
 * reordering is never returned: either every candidate gets a real score, or
 * none of them do.
 */
export class JevReranker implements Reranker {
  private readonly fetchFn: JevFetchFn;
  private readonly timeoutMs: number;

  constructor(
    private readonly token: string,
    options: JevRerankerOptions = {}
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? RERANK_TIMEOUT_MS;
  }

  async rerank(query: string, candidates: RerankCandidate[]): Promise<number[] | null> {
    if (candidates.length === 0) return [];

    const stateCandidates: Record<string, { file: string; symbol?: string; content: string }> = {};
    const questions: Record<string, { type: "noul"; instructions: string }> = {};

    candidates.forEach((c, i) => {
      const key = `c${i}`;
      stateCandidates[key] = {
        file: c.file,
        ...(c.symbol ? { symbol: c.symbol } : {}),
        content: c.content.slice(0, MAX_CONTENT_CHARS),
      };
      questions[key] = {
        type: "noul",
        instructions:
          `Candidate \`candidates.${key}\` is code or docs that a developer would need to read ` +
          `to answer or implement \`query\`.`,
      };
    });

    let response: Response;
    try {
      response = await this.fetchFn(TYPESAFE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "jev-latest",
          state: { query, candidates: stateCandidates },
          questions,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Network error, abort, or timeout — treat as opt-out, not a crash.
      return null;
    }

    if (!response.ok) return null;

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return null;
    }

    const answers = (data as { answers?: Record<string, { noul?: unknown }> } | null)?.answers;
    if (!answers || typeof answers !== "object") return null;

    const scores: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const noul = answers[`c${i}`]?.noul;
      // Any missing/non-numeric answer invalidates the whole batch — never
      // partially reorder on a partial response.
      if (typeof noul !== "number") return null;
      scores.push(noul);
    }
    return scores;
  }
}
