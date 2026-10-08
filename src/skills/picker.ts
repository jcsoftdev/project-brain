import { resolveRerankerToken } from "../rerank/token.js";
import { ask, type ChoiceQuestion, type TypesafeFetchFn } from "../typesafe/client.js";
import { isTrivialPrompt } from "../commands/trivial-prompt.js";
import { discoverSkills, type DiscoverOptions, type SkillInfo } from "./discovery.js";

/**
 * Candidates sent to Jev. Every one adds a description to the request body
 * and a label to the choice, which costs latency inside a 1.5s budget; a
 * dozen keyword-ranked skills covers the realistic shortlist for one prompt.
 */
export const MAX_SKILL_CANDIDATES = 12;

/** Description length per candidate — enough to say when the skill applies, small enough to keep the body light. */
export const MAX_DESCRIPTION_CHARS = 220;

/** Top probability needed to suggest. Below it, silence beats a wrong nudge on every prompt. */
export const SKILL_CONFIDENCE_THRESHOLD = 0.7;

/** The whole pick (discovery + Jev) must fit here so the prompt hook stays fast. */
export const SKILL_PICK_BUDGET_MS = 1500;

const NONE = "none";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "use", "when", "you", "your", "are", "can", "not",
  "how", "what", "why", "please", "para", "con", "que", "los", "las", "una", "por", "del", "como", "esto",
]);

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOPWORDS.has(w)));
}

/**
 * Cheap keyword-overlap shortlist: keeps skills sharing at least one word
 * with the prompt, best overlap first, capped at {@link MAX_SKILL_CANDIDATES}.
 * A prompt that overlaps nothing yields nothing, so Jev is not called at all.
 */
export function prefilterSkills(prompt: string, skills: SkillInfo[], cap = MAX_SKILL_CANDIDATES): SkillInfo[] {
  const promptWords = words(prompt);
  return skills
    .map((skill, index) => {
      const own = words(`${skill.name} ${skill.description}`);
      let overlap = 0;
      for (const w of promptWords) if (own.has(w)) overlap++;
      return { skill, overlap, index };
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.index - b.index)
    .slice(0, cap)
    .map((s) => s.skill);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export interface SkillPickDeps {
  /** Resolves the TypeSafe token; null → picker silently off. */
  getToken?: () => Promise<string | null>;
  discover?: () => Promise<SkillInfo[]>;
  fetchFn?: TypesafeFetchFn;
  env?: Record<string, string | undefined>;
  budgetMs?: number;
  /** Test seam for discovery options (home, cache dir). */
  discoverOptions?: DiscoverOptions;
}

export function skillPickerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BRAIN_SKILL_PICKER !== "0";
}

/**
 * One `choice` over the candidate names plus "none": the options are mutually
 * exclusive, a single call returns calibrated probabilities to threshold, and
 * "none" gives Jev an explicit way to decline instead of forcing a best-of-N.
 *
 * Resolves to the line to inject, or null — never throws, never logs the token.
 */
export async function pickSkill(prompt: string, deps: SkillPickDeps & { projectDir: string }): Promise<string | null> {
  try {
    if (!skillPickerEnabled(deps.env) || isTrivialPrompt(prompt)) return null;

    const budgetMs = deps.budgetMs ?? SKILL_PICK_BUDGET_MS;
    const deadline = Date.now() + budgetMs;

    const token = await (deps.getToken ?? (() => resolveRerankerToken()))();
    if (!token) return null;

    const skills = await (deps.discover ?? (() => discoverSkills(deps.discoverOptions ?? { projectDir: deps.projectDir })))();
    const candidates = prefilterSkills(prompt, skills);
    if (candidates.length === 0) return null;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;

    const described = candidates.map((c) => ({ name: c.name, description: truncate(c.description, MAX_DESCRIPTION_CHARS) }));
    const criteria: Record<string, string> = Object.fromEntries(
      described.map((c) => [c.name, `The request is best served by the \`${c.name}\` skill.`])
    );
    criteria[NONE] = "No listed skill clearly fits the request.";

    const question: ChoiceQuestion = {
      type: "choice",
      instructions:
        "Which of `skills` should the assistant load to handle `prompt`? Pick a skill only when its description clearly matches the request; otherwise pick none.",
      criteria,
    };

    const answers = await ask(token, { prompt, skills: described }, { pick: question }, {
      fetchFn: deps.fetchFn,
      timeoutMs: remaining,
    });
    if (!answers) return null;

    const { choice, probabilities } = answers.pick;
    const confidence = probabilities[choice];
    if (choice === NONE || typeof confidence !== "number" || confidence < SKILL_CONFIDENCE_THRESHOLD) return null;

    const picked = described.find((c) => c.name === choice);
    return picked ? `Suggested skill: ${picked.name} — ${truncate(picked.description, 120)}` : null;
  } catch {
    return null;
  }
}
