/**
 * The closing block every delegation prompt asks for, so a sub-agent hands back a
 * verdict-first summary instead of a transcript-sized one. Long hand-backs land in
 * the parent's context and stay there until it compacts; the detail goes to a file
 * the parent reads only when it needs it.
 *
 * One definition feeds the routing skill, the SessionStart reminder and the opt-in
 * PreToolUse hook, so the three never drift apart.
 */

export const REPORT_CONTRACT_HEADING = "## Report contract";

export const REPORT_CONTRACT_WORD_CAP = 400;

export const REPORT_CONTRACT = `${REPORT_CONTRACT_HEADING}

End with a report of at most ~${REPORT_CONTRACT_WORD_CAP} words, in this order:
- Verdict: PASS, BLOCKERS, PARTIAL or DONE.
- Changes: commits and files, one line each.
- Tests: the counts.
- Risks.
- Needs a decision: what only the caller can decide, or "none".
- Detail: the path of a file under the job tmp or the worktree that holds the full detail.`;

/** One line for places that pay per session, such as the SessionStart reminder. */
export const REPORT_CONTRACT_LINE =
  `Close every delegation prompt with the report contract: Verdict (PASS/BLOCKERS/PARTIAL/DONE), ` +
  `Changes, Tests (counts), Risks, Needs a decision; at most ~${REPORT_CONTRACT_WORD_CAP} words; ` +
  `full detail in a file under the job tmp or worktree, path in the report.`;

/**
 * A prompt that already fixes its own output shape keeps it: a caller parsing JSON
 * or a set report format would break on a second, competing contract.
 */
const STRUCTURED_OUTPUT = [
  /\b(?:return|respond|reply|output|answer|emit|print|report)\b[^.\n]{0,80}\b(?:json|yaml|csv|xml|ndjson)\b/i,
  /\b(?:json|yaml)\b[^.\n]{0,40}\b(?:object|array|schema|only|format)\b/i,
  /```(?:json|yaml)\b/i,
  /\bstructured output\b/i,
  /\b(?:output|report|response) format\b/i,
  /\breport in at most\b/i,
  /^#+\s*(?:output|report|response)\b/im,
];

export function asksForStructuredOutput(prompt: string): boolean {
  return STRUCTURED_OUTPUT.some((pattern) => pattern.test(prompt));
}

export function hasReportContract(prompt: string): boolean {
  return prompt.includes(REPORT_CONTRACT_HEADING);
}

/** The prompt with the contract appended once; unchanged when it carries one or sets its own output shape. */
export function withReportContract(prompt: string): string {
  if (hasReportContract(prompt) || asksForStructuredOutput(prompt)) return prompt;
  return `${prompt.trimEnd()}\n\n${REPORT_CONTRACT}\n`;
}
