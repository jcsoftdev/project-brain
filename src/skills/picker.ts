import { resolveRerankerToken } from "../rerank/token.js";
import { ask, type ChoiceQuestion, type ChoiceAnswer, type NoulQuestion, type TypesafeFetchFn } from "../typesafe/client.js";
import { isTrivialPrompt } from "../commands/trivial-prompt.js";
import { rankSkillsSemantic, type SharedQuery } from "./semantic.js";
import { discoverSkills, type DiscoverOptions, type SkillInfo } from "./discovery.js";
import { loadCatalogForHook } from "../toolcatalog/catalog.js";
import type { ToolEntry } from "../toolcatalog/live.js";
import { rankToolsSemantic } from "../toolcatalog/shortlist.js";
import { taskSwitchQuestion } from "../hooks/task-switch.js";
import { readSkillsConfig, type SkillsConfig } from "./config.js";
import { readListedSkills, withListedSkills } from "./listed.js";
import { DATA_DIR } from "../constants.js";

/**
 * Candidates sent to Jev. Every one adds a description to the request body
 * and a label to the choice, which costs latency inside a 1.5s budget; a
 * dozen keyword-ranked skills covers the realistic shortlist for one prompt.
 */
export const MAX_SKILL_CANDIDATES = 12;

/**
 * Process skills are always judged, on top of the nearest {@link MAX_SKILL_CANDIDATES}: a task
 * prompt names the work, not the process, so embeddings rank them far down. Measured on 135
 * installed skills, "construye una feature nueva de login" put superpowers:brainstorming at #58.
 */
export const MAX_PROCESS_CANDIDATES = 16;

/** A skill that says when to use it rather than what it covers: "Use when …", "You MUST use this before …". */
const PROCESS_DESCRIPTION = /^(use (this )?(when|before|after)\b|you must use\b)/i;

export const isProcessSkill = (skill: { description: string }): boolean => PROCESS_DESCRIPTION.test(skill.description.trim());

async function discoverWithListed(deps: SkillPickDeps & { projectDir: string }): Promise<SkillInfo[]> {
  const discovered = await discoverSkills(deps.discoverOptions ?? { projectDir: deps.projectDir });
  return withListedSkills(discovered, await readListedSkills(deps.discoverOptions?.cacheDir ?? DATA_DIR));
}

function uniqueByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.name) && (seen.add(item.name), true));
}

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
  taskSwitch?: { recent: string[]; assistant?: { text: string; tools: string[] } };
  /** Receives Jev's probabilities for the task-switch question. Not called when it was not asked or Jev failed. */
  onTaskSwitch?: (probabilities: Record<string, number>) => void;
  /** Told whether a Jev request that asked about skills got an answer. The CLI records it for the listing mod; absent, nothing is recorded. */
  recordHealth?: (ok: boolean) => Promise<unknown>;
  /** `~/.project-brain/skills.json` with its env overrides. Injectable for tests. */
  skillsConfig?: SkillsConfig;
  /**
   * Jev picks every skill that clears the floor; `pickCeiling` only guards against a response that
   * clears it for nearly the whole shortlist. Told when that happens. Defaults to a stderr line.
   */
  onCeiling?: (cleared: number, ceiling: number) => void;
}

export function toolPickerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BRAIN_TOOL_PICKER !== "0";
}

export function skillPickerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BRAIN_SKILL_PICKER !== "0";
}

function toolQuestion(names: string[]): ChoiceQuestion {
  const criteria: Record<string, string> = Object.fromEntries(
    names.map((name) => [name, `The request is best served by the \`${name}\` tool.`])
  );
  criteria[NONE] = "No listed tool clearly fits the request.";
  return {
    type: "choice",
    instructions:
      "Which of `tools` should the assistant call to carry out `prompt`? Pick a tool only when its description clearly matches what the request asks to do; otherwise pick none.",
    criteria,
  };
}

export const skillQuestionKey = (index: number): string => `skill_${index}`;

/**
 * One yes/no judgment per shortlisted skill rather than one choice among them: a task usually needs
 * a process skill (planning, debugging, review) and a domain skill (the framework it touches) at
 * once, and a choice question can only ever name one.
 */
function skillQuestion(index: number): NoulQuestion {
  return {
    type: "noul",
    instructions:
      `The assistant needs skill \`skills.${index}\` to do the work \`prompt\` asks for: either because the work follows the process ` +
      "it describes (planning, brainstorming, debugging, testing, reviewing, committing) or because the work touches the domain, " +
      "framework or tool it covers. Several skills can apply to the same request; judge this one on its own.",
  };
}

interface Described {
  name: string;
  description: string;
}

const describe = (items: Described[]): Described[] =>
  items.map((c) => ({ name: c.name, description: truncate(c.description, MAX_DESCRIPTION_CHARS) }));

/** The confident choice among `shortlist`, or null when Jev declined, was unsure or answered with an unknown label. */
function confident(answer: ChoiceAnswer | undefined, shortlist: Described[]): Described | null {
  if (!answer || answer.choice === NONE) return null;
  const confidence = answer.probabilities[answer.choice];
  if (typeof confidence !== "number" || confidence < SKILL_CONFIDENCE_THRESHOLD) return null;
  return shortlist.find((c) => c.name === answer.choice) ?? null;
}

/** Every skill whose judgment clears the floor, best first, cut at the ceiling. */
export function pickedSkills(
  answers: Record<string, { noul: number } | undefined>,
  shortlist: SkillInfo[],
  ceiling: number,
  onCeiling: (cleared: number, ceiling: number) => void = () => {}
): SkillInfo[] {
  const cleared = shortlist
    .map((skill, index) => ({ skill, score: answers[skillQuestionKey(index)]?.noul ?? 0 }))
    .filter((s) => s.score >= SKILL_CONFIDENCE_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  if (cleared.length > ceiling) onCeiling(cleared.length, ceiling);
  return cleared.slice(0, ceiling).map((s) => s.skill);
}

/** One line per skill, with the whole description: under a names-only listing the model has no other copy of it. */
export const skillLine = (skill: Described): string =>
  `Suggested skill: ${skill.name} — ${skill.description.replace(/\s*\n\s*/g, " ").trim()}`;

const warnCeiling = (cleared: number, ceiling: number): void =>
  console.error(`  project-brain: ${cleared} skills cleared the pick floor; suggesting the top ${ceiling} (BRAIN_SKILL_PICK_MAX)`);

interface Picks {
  skills: string[];
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
  const none: Picks = { skills: [], tool: null };
  const config = deps.skillsConfig ?? readSkillsConfig(undefined, deps.env ?? process.env);
  const wantSkills = want.skills && skillPickerEnabled(deps.env) && config.picker;
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
    const general = new Set(config.general);
    const discovered = await (deps.discover ?? (() => discoverWithListed(deps)))();
    // A general-use skill keeps its full line in the listing, so a pick would only repeat it.
    const skills = discovered.filter((s) => !general.has(s.name));
    const semantic = shared ? await rankSkillsSemantic(skills, shared, MAX_SKILL_CANDIDATES, deps.vectorCacheDir) : null;
    const nearest = semantic && semantic.length > 0 ? semantic : prefilterSkills(prompt, skills);
    const processSkills = skills.filter(isProcessSkill);
    const process = shared ? await rankSkillsSemantic(processSkills, shared, MAX_PROCESS_CANDIDATES, deps.vectorCacheDir) : null;
    return uniqueByName([...nearest, ...(process ?? processSkills.slice(0, MAX_PROCESS_CANDIDATES))]);
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

  const questions: Record<string, ChoiceQuestion | NoulQuestion> = {};
  const state: Record<string, unknown> = { prompt };
  if (skills.length > 0) {
    state.skills = skills;
    skills.forEach((_, index) => (questions[skillQuestionKey(index)] = skillQuestion(index)));
  }
  if (tools.length > 0) {
    state.tools = tools;
    questions.tool = toolQuestion(tools.map((c) => c.name));
  }

  if (deps.taskSwitch) {
    state.recent_prompts = deps.taskSwitch.recent;
    if (deps.taskSwitch.assistant) state.last_assistant_turn = { text: deps.taskSwitch.assistant.text, tools_used: deps.taskSwitch.assistant.tools };
    questions.switch = taskSwitchQuestion();
  }

  const answers = await ask(token, state, questions, {
    fetchFn: deps.fetchFn,
    timeoutMs: deps.jevTimeoutMs ?? SKILL_JEV_TIMEOUT_MS,
  });
  if (skills.length > 0) await deps.recordHealth?.(answers !== null).catch(() => undefined);
  if (!answers) return none;

  const picked = pickedSkills(
    answers as Record<string, { noul: number } | undefined>,
    skillCandidates,
    config.pickCeiling,
    deps.onCeiling ?? warnCeiling
  );
  const tool = confident(answers.tool as ChoiceAnswer | undefined, tools);
  return {
    skills: picked.map(skillLine),
    tool: tool ? `Suggested tool: ${tool.name} — ${truncate(tool.description, 120)}` : null,
    switchProbabilities: (answers.switch as ChoiceAnswer | undefined)?.probabilities,
  };
}

/**
 * Skill suggestions only: one line per picked skill, joined, or null when none
 * was picked. Never throws, never logs the token.
 */
export async function pickSkill(prompt: string, deps: SkillPickDeps & { projectDir: string }): Promise<string | null> {
  try {
    const { skills } = await pickLines(prompt, deps, { skills: true, tools: false });
    return skills.length > 0 ? skills.join("\n") : null;
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
    const { skills, tool, switchProbabilities } = await pickLines(prompt, deps, { skills: true, tools: true });
    if (switchProbabilities) deps.onTaskSwitch?.(switchProbabilities);
    return tool === null ? skills : [...skills, tool];
  } catch {
    return [];
  }
}
