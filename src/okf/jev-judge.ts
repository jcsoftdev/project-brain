import { JEV_JUDGE_MIN_CONFIDENCE } from "../constants.js";
import { ask, type ChoiceAnswer, type TypesafeFetchFn } from "../typesafe/client.js";
import type { JudgeInput, JudgeResult, StaleJudge, Verdict } from "./judge.js";

/**
 * Jev-backed `StaleJudge` (`okf audit --judge-model jev`).
 *
 * Same contract as `createClaudeJudge`, at a different price point: one
 * `choice` question over the three verdicts is a single ~0.5s Jev call
 * instead of an opus-5 call with adaptive thinking. Never throws — any
 * failure (opt-out, network, timeout, malformed response) resolves to
 * "unclear", exactly like a `parseJudgeResponse` fallback, so a run using the
 * Jev judge degrades to "needs a human look" rather than crashing the audit.
 */

const VERDICTS: readonly Verdict[] = ["holds", "outdated", "unclear"];

const CRITERIA: Record<Verdict, string> = {
  holds: "the concept's reasoning still holds after the diff — a rename, a line shift, or a refactor that preserves behavior",
  outdated: "the diff contradicts or removes what the concept claims",
  unclear: "the diff does not give enough to decide either way",
};

const INSTRUCTIONS =
  "Given a written concept's stated reasoning (`state.conceptBody`) and a git diff of what changed in the " +
  "code it anchors since it was last confirmed (`state.diff`), judge whether the concept's reasoning still holds.";

export interface JevJudgeOptions {
  /** Injectable HTTP call. Defaults to the real global fetch. */
  fetchFn?: TypesafeFetchFn;
  /** Per-request timeout, ms. */
  timeoutMs?: number;
  /** Below this confidence, the verdict is downgraded to "unclear". Defaults to JEV_JUDGE_MIN_CONFIDENCE. */
  minConfidence?: number;
}

function formatReason(answer: ChoiceAnswer): string {
  return `jev: ${answer.choice} p=${answer.confidence.toFixed(2)}`;
}

export function createJevJudge(token: string, options: JevJudgeOptions = {}): StaleJudge {
  const minConfidence = options.minConfidence ?? JEV_JUDGE_MIN_CONFIDENCE;

  return {
    async judge(input: JudgeInput): Promise<JudgeResult> {
      const answers = await ask(
        token,
        { conceptBody: input.conceptBody, diff: input.diff },
        {
          verdict: { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA },
        },
        { fetchFn: options.fetchFn, timeoutMs: options.timeoutMs }
      );

      if (!answers) {
        return { verdict: "unclear", reason: "jev: no answer (network, timeout, or malformed response)" };
      }

      const answer = answers.verdict;
      if (answer.confidence < minConfidence) {
        return { verdict: "unclear", reason: `jev: low confidence p=${answer.confidence.toFixed(2)}` };
      }
      if (!VERDICTS.includes(answer.choice as Verdict)) {
        return { verdict: "unclear", reason: `jev: unexpected choice "${answer.choice}"` };
      }

      return { verdict: answer.choice as Verdict, reason: formatReason(answer) };
    },
  };
}
