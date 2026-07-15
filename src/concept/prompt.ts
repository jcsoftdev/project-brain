export interface ConceptPromptInput {
  module: string;
  commitMessage: string;
  diff: string;
  existingDoc: string;
}

/** Builds the prompt asking the LLM to update a module's conceptual summary from a commit's diff. */
export function buildConceptPrompt(input: ConceptPromptInput): string {
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
