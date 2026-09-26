/**
 * Shared TypeSafe/Jev client.
 *
 * One POST to the `systemone` endpoint can carry many independently-answered
 * questions against the same `state` (System One evaluates them in parallel),
 * so every caller that needs more than one judgment from Jev — reranking,
 * OKF staleness, OKF candidate scoring — fans its questions into ONE `ask()`
 * call instead of one round trip per question.
 *
 * Never throws: any failure (network error, timeout, abort, non-2xx, a body
 * that isn't JSON, a missing answer, or an answer whose shape doesn't match
 * its question's type) resolves the WHOLE call to null. A caller that gets a
 * non-null result back can trust every key in it — there is no partial/mixed
 * result to reason about, matching the all-or-nothing contract `JevReranker`
 * already relied on before this module existed.
 */

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 1500;

/** Injectable fetch-like function — every caller passes this through so tests never stub global fetch. */
export type TypesafeFetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface NoulQuestion {
  type: "noul";
  instructions: string;
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** label -> description of what picking that label means. */
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered level descriptions, index 0 = lowest. */
  criteria: string[];
}

export type TypesafeQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
}

export type TypesafeAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** Maps each question's declared type to the answer shape `ask()` guarantees for it. */
type AnswerForQuestion<Q> = Q extends { type: "noul" }
  ? NoulAnswer
  : Q extends { type: "choice" }
    ? ChoiceAnswer
    : Q extends { type: "score" }
      ? ScoreAnswer
      : never;

export type AnswersFor<Q extends Record<string, TypesafeQuestion>> = {
  [K in keyof Q]: AnswerForQuestion<Q[K]>;
};

export interface AskOptions {
  /** Injectable HTTP call. Defaults to the real global fetch. */
  fetchFn?: TypesafeFetchFn;
  /** Per-request timeout, ms. Defaults to 1500. */
  timeoutMs?: number;
  /** Overrides the model id. Defaults to "jev-latest". */
  model?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates one raw answer against the type its question declared, without trusting the answer's own `type` field. */
function coerceAnswer(question: TypesafeQuestion, raw: unknown): TypesafeAnswer | null {
  if (!isPlainObject(raw)) return null;

  if (question.type === "noul") {
    return typeof raw.noul === "number" ? { type: "noul", noul: raw.noul } : null;
  }

  if (question.type === "choice") {
    if (
      typeof raw.choice !== "string" ||
      typeof raw.confidence !== "number" ||
      !isPlainObject(raw.probabilities)
    ) {
      return null;
    }
    return {
      type: "choice",
      choice: raw.choice,
      confidence: raw.confidence,
      probabilities: raw.probabilities as Record<string, number>,
    };
  }

  // question.type === "score"
  if (
    typeof raw.score !== "number" ||
    typeof raw.confidence !== "number" ||
    !isPlainObject(raw.probabilities)
  ) {
    return null;
  }
  return {
    type: "score",
    score: raw.score,
    confidence: raw.confidence,
    probabilities: raw.probabilities as Record<string, number>,
    ...(isPlainObject(raw.legend) ? { legend: raw.legend as Record<string, string> } : {}),
  };
}

/**
 * Fans a batch of independently-answered questions out to Jev in one request.
 *
 * Returns null on ANY failure — see the module doc for the full list. A
 * non-null result is guaranteed to carry a validly-shaped answer for every
 * key in `questions`, typed per that question's declared `type`.
 */
export async function ask<Q extends Record<string, TypesafeQuestion>>(
  token: string,
  state: unknown,
  questions: Q,
  options: AskOptions = {}
): Promise<AnswersFor<Q> | null> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = options.model ?? DEFAULT_MODEL;

  let response: Response;
  try {
    response = await fetchFn(TYPESAFE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
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

  const rawAnswers = isPlainObject(data) ? data.answers : undefined;
  if (!isPlainObject(rawAnswers)) return null;

  const result: Record<string, TypesafeAnswer> = {};
  for (const key of Object.keys(questions)) {
    const answer = coerceAnswer(questions[key]!, rawAnswers[key]);
    // One missing/malformed answer invalidates the whole batch — a caller
    // must never see a partially-typed result.
    if (!answer) return null;
    result[key] = answer;
  }
  return result as AnswersFor<Q>;
}
