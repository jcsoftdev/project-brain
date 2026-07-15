import { buildConceptPrompt, type ConceptPromptInput } from "./prompt.js";
import type { LlmClient } from "../llm/anthropic-client.js";

/** Generates the updated conceptual markdown for a module via the LLM client. */
export async function generateConceptDoc(
  input: ConceptPromptInput,
  llm: LlmClient
): Promise<string> {
  const prompt = buildConceptPrompt(input);
  const doc = await llm.complete(prompt);
  return doc.trim();
}
