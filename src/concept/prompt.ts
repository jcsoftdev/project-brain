import { CONCEPT_CHARS_PER_TOKEN, CONCEPT_MAX_CONTEXT_TOKENS, CONCEPT_OUTPUT_TOKENS } from "../constants.js";

/** Longest prompt sent for one module, in characters. */
export const CONCEPT_PROMPT_MAX_CHARS = Math.floor(
  (CONCEPT_MAX_CONTEXT_TOKENS - CONCEPT_OUTPUT_TOKENS) * CONCEPT_CHARS_PER_TOKEN
);
/** A diff is never cut below this, even beside a very long existing doc. */
const MIN_DIFF_CHARS = 4000;

/** Keeps the head of `diff` within `maxChars`, marking what was cut from the end. */
export function capDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  const omitted = diff.length - maxChars;
  return `${diff.slice(0, maxChars)}\n[diff truncated: last ${omitted} of ${diff.length} characters omitted]\n`;
}

export const CONCEPT_HEADINGS = ["## Purpose", "## Key Files", "## Dependencies", "## Data Flow", "## Gotchas"] as const;

export interface ConceptPromptInput {
  module: string;
  commitMessage: string;
  diff: string;
  existingDoc: string;
}

/** Builds the prompt asking the LLM to update a module's conceptual summary from a commit's diff. */
export function buildConceptPrompt(input: ConceptPromptInput): string {
  const frame = render({ ...input, diff: "" });
  const budget = Math.max(MIN_DIFF_CHARS, CONCEPT_PROMPT_MAX_CHARS - frame.length - 200);
  return render({ ...input, diff: capDiff(input.diff, budget) });
}

function render(input: ConceptPromptInput): string {
  const { module, commitMessage, diff, existingDoc } = input;
  return `You are updating a living conceptual summary for the "${module}" module of a codebase. This summary is used later to answer questions like "what does X do" and "where is Y feature" — write for that reader, not for someone reviewing this commit.

Commit message:
${commitMessage}

Diff for this module in this commit:
${diff}

Existing summary for this module:
${existingDoc || "(none yet)"}

Update the summary to reflect this commit. Output ONLY the updated markdown, with exactly these headings, each filled in with concise, accurate prose (no placeholders, no TBD):

## Purpose

## Key Files

## Dependencies

## Data Flow

## Gotchas

Keep sections unaffected by this commit as they were. Do not include any text before "## Purpose" or after the Gotchas section.`;
}
