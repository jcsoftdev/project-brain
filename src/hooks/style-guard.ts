import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { DATA_DIR } from "../constants.js";
import { resolveRerankerToken } from "../rerank/token.js";
import { parseEditTarget } from "../style-guard/payload.js";
import { classifyPath, SKILL_RULES, type ShippedSkill } from "../style-guard/rules.js";
import { markSeen, parseSeen, unseenSkills } from "../style-guard/seen.js";
import { renderInjection, skillBody } from "../style-guard/skill-text.js";
import { ask, type AskOptions, type ChoiceAnswer, type ChoiceQuestion } from "../typesafe/client.js";

const JEV_TIMEOUT_MS = 2500;
const JEV_APPLIES_MIN_PROBABILITY = 0.7;

export type StyleAsk = (
  token: string,
  state: unknown,
  questions: Record<string, ChoiceQuestion>,
  options?: AskOptions
) => Promise<Record<string, ChoiceAnswer> | null>;

export interface StyleGuardContext {
  readSkill(skill: ShippedSkill): Promise<string | null>;
  readSeen(sessionId: string): Promise<Set<string>>;
  writeSeen(sessionId: string, seen: string[]): Promise<void>;
  token(): Promise<string | null>;
  ask?: StyleAsk;
}

function applicabilityQuestions(): Record<string, ChoiceQuestion> {
  return Object.fromEntries(
    SKILL_RULES.map((rule): [string, ChoiceQuestion] => [
      rule.skill,
      {
        type: "choice",
        instructions: `Does the guidance "${rule.skill}" (${rule.summary}) apply to editing the file \`state.file\`?`,
        criteria: {
          yes: "the file is source code or code-like text this guidance is about",
          no: "the file is prose, data, configuration or a binary format this guidance does not cover",
        },
      },
    ])
  );
}

function probabilityApplies(answer: ChoiceAnswer): number {
  const p = answer.probabilities.yes;
  if (typeof p === "number") return p;
  return answer.choice === "yes" ? answer.confidence : 0;
}

async function skillsFromJev(filePath: string, ctx: StyleGuardContext): Promise<ShippedSkill[]> {
  const token = await ctx.token();
  if (!token) return [];
  const answers = await (ctx.ask ?? (ask as StyleAsk))(token, { file: filePath }, applicabilityQuestions(), {
    timeoutMs: JEV_TIMEOUT_MS,
  });
  if (!answers) return [];
  return SKILL_RULES.filter((rule) => {
    const answer = answers[rule.skill];
    return answer !== undefined && probabilityApplies(answer) >= JEV_APPLIES_MIN_PROBABILITY;
  }).map((rule) => rule.skill);
}

async function applicableSkills(filePath: string, ctx: StyleGuardContext): Promise<ShippedSkill[]> {
  const verdict = classifyPath(filePath);
  if (verdict.kind === "apply") return verdict.skills;
  if (verdict.kind === "skip") return [];
  return skillsFromJev(filePath, ctx);
}

async function loadBodies(skills: ShippedSkill[], ctx: StyleGuardContext) {
  const loaded = await Promise.all(
    skills.map(async (skill) => ({ skill, markdown: await ctx.readSkill(skill) }))
  );
  return loaded.flatMap(({ skill, markdown }) => (markdown === null ? [] : [{ skill, body: skillBody(markdown) }]));
}

export async function styleGuardInjection(payload: unknown, ctx: StyleGuardContext): Promise<string | null> {
  try {
    const target = parseEditTarget(payload);
    if (!target) return null;

    const seen = await ctx.readSeen(target.sessionId);
    const wanted = await applicableSkills(target.filePath, ctx);
    const pending = unseenSkills(seen, target.agentId, wanted);
    if (pending.length === 0) return null;

    const bodies = await loadBodies(pending, ctx);
    if (bodies.length === 0) return null;

    const marked = markSeen(seen, target.agentId, bodies.map((entry) => entry.skill));
    await ctx.writeSeen(target.sessionId, marked).catch(() => undefined);
    return renderInjection(bodies);
  } catch {
    return null;
  }
}

const sessionFile = (dataDir: string, sessionId: string) =>
  join(dataDir, "style-guard", `${sessionId.replace(/[^\w-]/g, "_")}.json`);

export function readStyleGuardContext(dataDir: string = DATA_DIR, home: string = homedir()): StyleGuardContext {
  return {
    readSkill: (skill) => readFile(join(home, ".claude", "skills", skill, "SKILL.md"), "utf8").catch(() => null),
    readSeen: async (sessionId) => parseSeen(await readFile(sessionFile(dataDir, sessionId), "utf8").catch(() => null)),
    writeSeen: async (sessionId, seen) => {
      await writeFileAtomic(sessionFile(dataDir, sessionId), `${JSON.stringify(seen)}\n`);
    },
    token: () => resolveRerankerToken({ dataDir }),
  };
}

export async function execute(): Promise<void> {
  try {
    const injection = await styleGuardInjection(JSON.parse(await Bun.stdin.text()), readStyleGuardContext());
    if (injection) {
      const output = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: injection } };
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch {
    process.exit(0);
  }
  process.exit(0);
}
