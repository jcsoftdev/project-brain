import type { AskFailure } from "../typesafe/client.js";
import type { RerankCandidate, RerankOutcome, Reranker } from "./jev.js";

export type RerankerProbe =
  | { status: "reachable"; latencyMs: number }
  | { status: "degraded"; reason: AskFailure; latencyMs: number }
  | { status: "not-configured" };

/** Synthetic on purpose: the probe must never ship the user's code to a third party. */
const PROBE_QUERY = "user login";
const PROBE_CANDIDATES: RerankCandidate[] = [
  { file: "probe/auth.ts", content: "function login(user, password) { return verifyCredentials(user, password); }" },
  { file: "probe/format.ts", content: "function formatDate(date) { return date.toISOString(); }" },
];

/**
 * One tiny live rerank call, so health can tell "Jev is down" from "Jev is
 * on" — `rerankPool` silently keeps the base order on any failure. Never
 * throws; the clock is injectable for tests.
 */
export async function probeReranker(
  reranker: Reranker | undefined,
  now: () => number = () => performance.now()
): Promise<RerankerProbe> {
  if (!reranker) return { status: "not-configured" };

  const start = now();
  let outcome: RerankOutcome;
  try {
    if (reranker.rerankWithReason) {
      outcome = await reranker.rerankWithReason(PROBE_QUERY, PROBE_CANDIDATES);
    } else {
      const scores = await reranker.rerank(PROBE_QUERY, PROBE_CANDIDATES);
      outcome = scores ? { scores } : { reason: "network error" };
    }
  } catch {
    outcome = { reason: "network error" };
  }
  const latencyMs = now() - start;

  return "scores" in outcome
    ? { status: "reachable", latencyMs }
    : { status: "degraded", reason: outcome.reason, latencyMs };
}

/** One CLI line; the token never reaches this far. */
export function formatRerankerProbeLine(probe: RerankerProbe): string | undefined {
  if (probe.status === "not-configured") return undefined;
  const ms = `${Math.round(probe.latencyMs)}ms`;
  return probe.status === "reachable"
    ? `Jev probe: reachable (${ms})`
    : `Jev probe: degraded — ${probe.reason} after ${ms}; search keeps the unreranked order`;
}
