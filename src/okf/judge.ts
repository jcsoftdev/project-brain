import { spawnSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { OKF_JUDGE_MODEL } from "../constants.js";
import type { SpawnFn } from "../git/last-changed.js";
import type { StaleFinding } from "./audit.js";

/**
 * Opt-in Claude judgment of stale findings (`okf audit --judge`).
 *
 * A `code-changed` finding means the code under an anchor moved after the
 * concept was last attested — but code moving does not always mean the
 * concept's REASONING broke. A rename, a line shift, a refactor that keeps the
 * same behavior: all trip staleness on the git-clock alone, and all are false
 * positives a human would dismiss in one glance. `--judge` sends the concept's
 * prose and the actual diff to a model to make that same call, cheaply, before
 * a human has to.
 *
 * Deliberately never auto-attests: the strongest thing a "holds" verdict does
 * is move a finding off the failing list and onto a backlog for confirmation.
 * A `verified` entry is still a human act.
 */

export type Verdict = "holds" | "outdated" | "unclear";

export interface JudgeResult {
  verdict: Verdict;
  reason: string;
}

export interface JudgeInput {
  /** The concept's markdown body — its stated reasoning. */
  conceptBody: string;
  /** Evidence of what changed: a `git diff`, or a `git log -L` excerpt for a ranged anchor. */
  diff: string;
}

export interface StaleJudge {
  judge(input: JudgeInput): Promise<JudgeResult>;
}

const VERDICTS: readonly Verdict[] = ["holds", "outdated", "unclear"];

/** Minimal shape of a Claude API response this module reads — decoupled from the SDK's types so it can be unit-tested without a live client. */
export interface JudgeApiResponse {
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
}

/**
 * Turns a raw API response into a verdict, never throwing.
 *
 * Every failure mode collapses to "unclear" rather than propagating: a stop
 * reason of `refusal`/`max_tokens` before reading content (nothing there is
 * trustworthy), no text block (thinking blocks come first and may be the only
 * content), and a text block that fails to parse or does not match the
 * schema. Pulled out of `createClaudeJudge` so it is testable without a
 * network call.
 */
export function parseJudgeResponse(response: JudgeApiResponse): JudgeResult {
  if (response.stop_reason === "refusal") return { verdict: "unclear", reason: "refusal" };
  if (response.stop_reason === "max_tokens") return { verdict: "unclear", reason: "max_tokens" };

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.text === undefined) {
    return { verdict: "unclear", reason: "no text block in judge response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    return { verdict: "unclear", reason: "could not parse judge response as JSON" };
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "verdict" in parsed &&
    "reason" in parsed &&
    VERDICTS.includes((parsed as { verdict: unknown }).verdict as Verdict) &&
    typeof (parsed as { reason: unknown }).reason === "string"
  ) {
    return parsed as JudgeResult;
  }
  return { verdict: "unclear", reason: "judge response did not match the expected schema" };
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    reason: { type: "string" },
  },
  required: ["verdict", "reason"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You judge whether a piece of written knowledge (a "concept" in an Open Knowledge Format bundle) still holds true after the code it explains was edited.

You are given the concept's markdown body — its stated reasoning — and a git diff (or a \`git log -L\` excerpt) of what changed in the code it anchors since the concept was last attested.

Code moving does not by itself mean the concept is wrong: a rename, a line shift, or a refactor that preserves behavior should be judged "holds". Judge "outdated" only when the diff contradicts or removes what the concept claims. Judge "unclear" when the diff does not give you enough to decide either way.

Respond with a verdict and a short, specific reason a human can act on without re-reading the diff themselves.`;

/**
 * Zero-arg client, same pattern as `createAnthropicClient` — credentials
 * auto-resolve from whatever the host already has. `judge()` throws on the
 * first call if none is available; callers are expected to catch
 * `Anthropic.AuthenticationError` and abort the whole `--judge` run.
 */
export function createClaudeJudge(): StaleJudge {
  const client = new Anthropic();

  return {
    async judge(input: JudgeInput): Promise<JudgeResult> {
      const response = await client.beta.messages.create({
        model: OKF_JUDGE_MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-06-01"],
        fallbacks: [{ model: "claude-opus-4-8" }],
        thinking: { type: "adaptive" },
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `## Concept\n\n${input.conceptBody}\n\n## Code change since attestation\n\n${input.diff}`,
          },
        ],
      });

      return parseJudgeResponse(response);
    },
  };
}

export interface JudgeStaleFindingsDeps {
  judge: StaleJudge;
  /** Diff evidence for one finding, or null when it could not be produced (e.g. no commit at the baseline). */
  diff(finding: StaleFinding): string | null;
  conceptBody(concept: string): string;
  /** How many findings to judge at once. Default 3. */
  concurrency?: number;
  /** Above this many characters, a diff is skipped rather than silently truncated. Default 60,000. */
  maxDiffChars?: number;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_DIFF_CHARS = 60_000;

/**
 * Judges every `code-changed` finding concurrently (bounded), returning a
 * verdict per concept. `uncommitted`, `expired`, and broken-anchor findings
 * are never judged — none of them are a claim about whether the concept's
 * REASONING still holds, so there is nothing here for a model to weigh in on.
 *
 * `Anthropic.AuthenticationError` aborts the whole batch by rethrowing: a
 * credentials problem will not resolve itself finding-by-finding, and letting
 * every remaining call fail the same way would just burn the rest of the
 * concurrency window. `RateLimitError` and other `APIError`s are scoped to the
 * one finding that hit them — everything else keeps going.
 */
export async function judgeStaleFindings(
  findings: StaleFinding[],
  deps: JudgeStaleFindingsDeps
): Promise<Map<string, JudgeResult>> {
  const eligible = findings.filter((f) => f.reason === "code-changed");
  const results = new Map<string, JudgeResult>();
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const maxDiffChars = deps.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < eligible.length) {
      const finding = eligible[cursor++];
      const diff = deps.diff(finding);
      if (diff === null) {
        results.set(finding.concept, { verdict: "unclear", reason: "could not produce a diff for this anchor" });
        continue;
      }
      if (diff.length > maxDiffChars) {
        results.set(finding.concept, { verdict: "unclear", reason: "diff too large to judge" });
        continue;
      }

      try {
        const verdict = await deps.judge.judge({ conceptBody: deps.conceptBody(finding.concept), diff });
        results.set(finding.concept, verdict);
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) throw error;
        results.set(finding.concept, {
          verdict: "unclear",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, eligible.length) }, () => worker()));
  return results;
}

/**
 * Splits `stale` by verdict: a `"holds"` finding moves into `judged` — a
 * backlog for human confirmation, no longer failing the run — while
 * `"outdated"` and `"unclear"` stay in `stale`, annotated with the verdict so
 * both prose and `--json` output can show it. A finding with no verdict
 * (never eligible, or `--judge` was not run) passes through untouched.
 */
export function applyJudgeVerdicts(
  stale: StaleFinding[],
  verdicts: Map<string, JudgeResult>
): { stale: StaleFinding[]; judged: StaleFinding[] } {
  const nextStale: StaleFinding[] = [];
  const judged: StaleFinding[] = [];

  for (const finding of stale) {
    const verdict = verdicts.get(finding.concept);
    if (!verdict) {
      nextStale.push(finding);
      continue;
    }
    const annotated: StaleFinding = { ...finding, judge: verdict };
    if (verdict.verdict === "holds") judged.push(annotated);
    else nextStale.push(annotated);
  }

  return { stale: nextStale, judged };
}

export interface GitDiffFetcherDeps {
  spawn?: SpawnFn;
}

interface SpawnResult {
  ok: boolean;
  stdout: string;
}

function runGit(root: string, args: string[], spawn: SpawnFn): SpawnResult {
  const result = spawn("git", args, { cwd: root, encoding: "utf-8" });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

/** The commit at or before an ISO timestamp, or null when none exists (e.g. the timestamp predates the repo). */
function resolveBaselineCommit(root: string, baselineIso: string, spawn: SpawnFn): string | null {
  const { ok, stdout } = runGit(root, ["rev-list", "-n", "1", `--before=${baselineIso}`, "HEAD"], spawn);
  if (!ok) return null;
  const sha = stdout.trim();
  return sha || null;
}

/**
 * Diff evidence for one finding, git-backed.
 *
 * A ranged anchor gets `git log -L` — the history of exactly the cited lines
 * — rather than a plain diff, so a concept anchoring ten lines inside a
 * 500-line file is judged on those ten lines, not a firehose. A file-level
 * anchor gets a plain `git diff`. Returns null when the baseline attestation
 * date cannot be resolved to a commit, so the caller marks it unjudged rather
 * than judging against the wrong evidence.
 */
export function createGitDiffFetcher(root: string, deps: GitDiffFetcherDeps = {}): (finding: StaleFinding) => string | null {
  const spawn = deps.spawn ?? spawnSync;

  return (finding: StaleFinding): string | null => {
    if (!finding.attestedAt) return null;
    const baseline = resolveBaselineCommit(root, finding.attestedAt, spawn);
    if (!baseline) return null;

    const args = finding.range
      ? ["log", `-L${finding.range.start},${finding.range.end}:${finding.path}`, `${baseline}..HEAD`]
      : ["diff", `${baseline}..HEAD`, "--", finding.path];
    const { ok, stdout } = runGit(root, args, spawn);
    return ok ? stdout : null;
  };
}
