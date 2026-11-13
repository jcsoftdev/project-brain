import { buildConceptPrompt, CONCEPT_HEADINGS, type ConceptPromptInput } from "./prompt.js";
import type { LlmClient } from "../llm/client.js";

/**
 * The doc as it may be written to the index: from `## Purpose` on, with every
 * heading present and in order. A preamble before the first heading and a
 * closing code fence are dropped; anything else wrong throws, so a broken doc
 * is never stored.
 */
export function normalizeConceptDoc(text: string): string {
  const start = text.indexOf(CONCEPT_HEADINGS[0]);
  if (start === -1) throw new Error(`concept doc has no "${CONCEPT_HEADINGS[0]}" heading`);
  const doc = text
    .slice(start)
    .replace(/\n```\s*$/, "")
    .trim();
  let from = -1;
  for (const heading of CONCEPT_HEADINGS) {
    const at = doc.split("\n").findIndex((line, i) => i > from && line.trim() === heading);
    if (at === -1) throw new Error(`concept doc is missing "${heading}" or has it out of order`);
    from = at;
  }
  return doc;
}

/** Generates the updated conceptual markdown for a module via the LLM client. */
export async function generateConceptDoc(
  input: ConceptPromptInput,
  llm: LlmClient
): Promise<string> {
  const prompt = buildConceptPrompt(input);
  return normalizeConceptDoc(await llm.complete(prompt));
}
