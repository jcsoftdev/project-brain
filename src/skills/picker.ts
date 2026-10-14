import { resolveRerankerToken } from "../rerank/token.js";
import { ask, type ChoiceQuestion, type TypesafeFetchFn } from "../typesafe/client.js";
import { isTrivialPrompt } from "../commands/trivial-prompt.js";
import { rankSkillsSemantic, type SharedQuery } from "./semantic.js";
import { discoverSkills, type DiscoverOptions, type SkillInfo } from "./discovery.js";
import { loadCatalogForHook } from "../toolcatalog/catalog.js";
import type { ToolEntry } from "../toolcatalog/live.js";
import { rankToolsSemantic } from "../toolcatalog/shortlist.js";
import { taskSwitchQuestion } from "../hooks/task-switch.js";

/**
 * Candidates sent to Jev. Every one adds a description to the request body
 * and a label to the choice, which costs latency inside a 1.5s budget; a
 * dozen keyword-ranked skills covers the realistic shortlist for one prompt.
 */
export const MAX_SKILL_CANDIDATES = 12;

/**
 * The tool shortlist must not hold up the skill question: once the prompt
 * vector has arrived it gets this long, then the request goes without tools.
 */
export const TOOL_SHORTLIST_BUDGET_MS = 50;

/** Same cap for MCP tools, for the same latency reason. */
export const MAX_TOOL_CANDIDATES = 12;

/** Description length per candidate — enough to say when the skill applies, small enough to keep the body light. */
export const MAX_DESCRIPTION_CHARS = 220;

/** Top probability needed to suggest. Below it, silence beats a wrong nudge on every prompt. */
export const SKILL_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Jev's own timeout, counted from when the shortlist is ready (i.e. once the
 * shared prompt vector has arrived), not from hook start: the vector is only
 * published after store and embedding setup, which can be well over a second in.
 */
export const SKILL_JEV_TIMEOUT_MS = 1000;

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
  return prefilterNamed(prompt, skills, cap);
}

/** Same keyword shortlist for MCP tools, capped at {@link MAX_TOOL_CANDIDATES}. */
export function prefilterTools(prompt: string, tools: ToolEntry[], cap = MAX_TOOL_CANDIDATES): ToolEntry[] {
  return prefilterNamed(prompt, tools, cap);
}

function prefilterNamed<T extends { name: string; description: string }>(prompt: string, items: T[], cap: number): T[] {
  const promptWords = words(prompt);
  return items
    .map((item, index) => {
      const own = words(`${item.name} ${item.description}`);
      let overlap = 0;
      for (const w of promptWords) if (own.has(w)) overlap++;
      return { item, overlap, index };
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.index - b.index)
    .slice(0, cap)
    .map((s) => s.item);
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
  jevTimeoutMs?: number;
  /**
   * Resolves to the prompt embedding, or null when embeddings are unavailable. Present → semantic shortlist (works across
   * languages); null/absent → keyword fallback.
   */
  queryEmbedding?: () => Promise<SharedQuery | null>;
  /** Where skill vectors are cached. Defaults to the data dir. */
  vectorCacheDir?: string;
  /** Test seam for discovery options (home, cache dir). */
  discoverOptions?: DiscoverOptions;
  /** MCP tool catalog, read from cache only. Defaults to the on-disk catalog (which may spawn a detached refresh). */
  loadTools?: () => Promise<ToolEntry[]>;
  /** Where tool vectors are cached. Defaults to the data dir. */
  toolVectorCacheDir?: string;
  /** How long the tool shortlist may take once the prompt vector is in. Defaults to {@link TOOL_SHORTLIST_BUDGET_MS}. */
  toolBudgetMs?: number;
  /**
   * Present → the same Jev request also asks whether `prompt` starts an unrelated task, given these
   * earlier prompts. Absent → the question is not sent.
   */
  taskSwitch?: { recent: string[] };
  /** Receives Jev's probabilities for the task-switch question. Not called when it was not asked or Jev failed. */
  onTaskSwitch?: (probabilities: Record<string, number>) => void;
}

export function toolPickerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BRAIN_TOOL_PICKER !== "0";
}

export function skillPickerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BRAIN_SKILL_PICKER !== "0";
}

function choiceQuestion(kind: "skill" | "tool", names: string[]): ChoiceQuestion {
  const noun = kind === "skill" ? "skills" : "tools";
  const criteria: Record<string, string> = Object.fromEntries(
    names.map((name) => [name, `The request is best served by the \`${name}\` ${kind}.`])
  );
  criteria[NONE] = `No listed ${kind} clearly fits the request.`;
  return {
    type: "choice",
    instructions:
      kind === "skill"
        ? `Which of \`${noun}\` should the assistant load to handle \`prompt\`? Pick a skill only when its description clearly matches the request; otherwise pick none.`
        : `Which of \`${noun}\` should the assistant call to carry out \`prompt\`? Pick a tool only when its description clearly matches what the request asks to do; otherwise pick none.`,
    criteria,
  };
}

interface Described {
  name: string;
  description: string;
}

const describe = (items: Described[]): Described[] =>
  items.map((c) => ({ name: c.name, description: truncate(c.description, MAX_DESCRIPTION_CHARS) }));

/** The confident choice among `shortlist`, or null when Jev declined, was unsure or answered with an unknown label. */
function confident(answer: { choice: string; probabilities: Record<string, number> } | undefined, shortlist: Described[]): Described | null {
  if (!answer || answer.choice === NONE) return null;
  const confidence = answer.probabilities[answer.choice];
  if (typeof confidence !== "number" || confidence < SKILL_CONFIDENCE_THRESHOLD) return null;
  return shortlist.find((c) => c.name === answer.choice) ?? null;
}

interface Picks {
  skill: string | null;
  tool: string | null;
  switchProbabilities?: Record<string, number>;
}

/**
 * Shortlists skills and/or MCP tools, then asks Jev once. Each shortlist is one
 * `choice` question over its candidates plus "none": the options are mutually
 * exclusive, a single call returns calibrated probabilities to threshold, and
 * "none" gives Jev an explicit way to decline instead of forcing a best-of-N.
 * Both questions share one request, so a tool suggestion adds no round trip.
 * A kind with an empty shortlist is not asked; with both empty there is no call.
 */
async function pickLines(
  prompt: string,
  deps: SkillPickDeps & { projectDir: string },
  want: { skills: boolean; tools: boolean }
): Promise<Picks> {
  const none: Picks = { skill: null, tool: null };
  const wantSkills = want.skills && skillPickerEnabled(deps.env);
  const wantTools = want.tools && toolPickerEnabled(deps.env);
  // The task-switch question only rides along with a picker; with both opted out nothing leaves the machine.
  if ((!wantSkills && !wantTools) || isTrivialPrompt(prompt)) return none;

  const token = await (deps.getToken ?? (() => resolveRerankerToken()))();
  if (!token) return none;

  // The catalog read does not need the prompt vector, so it runs while the vector is still being computed.
  const catalog = wantTools
    ? (deps.loadTools ?? (() => loadCatalogForHook({ projectDir: deps.projectDir })))().catch((): ToolEntry[] => [])
    : Promise.resolve([] as ToolEntry[]);
  const shared = wantSkills || wantTools ? await (deps.queryEmbedding?.() ?? Promise.resolve(null)) : null;

  const shortlistSkills = async (): Promise<SkillInfo[]> => {
    if (!wantSkills) return [];
    const skills = await (deps.discover ?? (() => discoverSkills(deps.discoverOptions ?? { projectDir: deps.projectDir })))();
    const semantic = shared ? await rankSkillsSemantic(skills, shared, MAX_SKILL_CANDIDATES, deps.vectorCacheDir) : null;
    return semantic ?? prefilterSkills(prompt, skills);
  };
  const shortlistTools = async (): Promise<ToolEntry[]> => {
    const tools = await catalog;
    const semantic = shared ? await rankToolsSemantic(tools, shared, MAX_TOOL_CANDIDATES, deps.toolVectorCacheDir) : null;
    return semantic ?? prefilterTools(prompt, tools);
  };
  // The tool shortlist is the optional half: past its budget the skill question goes alone.
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const toolsInBudget = wantTools
    ? Promise.race([
        shortlistTools().catch((): ToolEntry[] => []),
        new Promise<ToolEntry[]>((resolve) => {
          budgetTimer = setTimeout(() => resolve([]), deps.toolBudgetMs ?? TOOL_SHORTLIST_BUDGET_MS);
        }),
      ])
    : Promise.resolve([] as ToolEntry[]);
  const [skillCandidates, toolCandidates] = await Promise.all([shortlistSkills(), toolsInBudget]);
  clearTimeout(budgetTimer);
  const skills = describe(skillCandidates);
  const tools = describe(toolCandidates);
  if (skills.length === 0 && tools.length === 0 && !deps.taskSwitch) return none;

  const questions: Record<string, ChoiceQuestion> = {};
  const state: Record<string, unknown> = { prompt };
  if (skills.length > 0) {
    state.skills = skills;
    questions.pick = choiceQuestion("skill", skills.map((c) => c.name));
  }
  if (tools.length > 0) {
    state.tools = tools;
    questions.tool = choiceQuestion("tool", tools.map((c) => c.name));
  }

  if (deps.taskSwitch) {
    state.recent_prompts = deps.taskSwitch.recent;
    questions.switch = taskSwitchQuestion();
  }

  const answers = await ask(token, state, questions, {
    fetchFn: deps.fetchFn,
    timeoutMs: deps.jevTimeoutMs ?? SKILL_JEV_TIMEOUT_MS,
  });
  if (!answers) return none;

  const skill = confident(answers.pick, skills);
  const tool = confident(answers.tool, tools);
  return {
    skill: skill ? `Suggested skill: ${skill.name} — ${truncate(skill.description, 120)}` : null,
    tool: tool ? `Suggested tool: ${tool.name} — ${truncate(tool.description, 120)}` : null,
    switchProbabilities: answers.switch?.probabilities,
  };
}

/**
 * Skill suggestion only. Resolves to the line to inject, or null — never
 * throws, never logs the token.
 */
export async function pickSkill(prompt: string, deps: SkillPickDeps & { projectDir: string }): Promise<string | null> {
  try {
    return (await pickLines(prompt, deps, { skills: true, tools: false })).skill;
  } catch {
    return null;
  }
}

/**
 * Every suggestion line for the hook — skill and/or tool — from ONE Jev
 * request. Never throws, never logs the token.
 */
export async function pickSuggestions(prompt: string, deps: SkillPickDeps & { projectDir: string }): Promise<string[]> {
  try {
    const { skill, tool, switchProbabilities } = await pickLines(prompt, deps, { skills: true, tools: true });
    if (switchProbabilities) deps.onTaskSwitch?.(switchProbabilities);
    return [skill, tool].filter((l): l is string => l !== null);
  } catch {
    return [];
  }
}
