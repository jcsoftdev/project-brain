import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELEGATION_SKILLS_HEADING, runAgentSuggest, runSuggest } from "../../src/commands/suggest.js";
import { DEFAULT_SKILLS_CONFIG, type SkillsConfig } from "../../src/skills/config.js";
import type { SkillInfo } from "../../src/skills/discovery.js";
import { pickSkill, pickSuggestions, pickedSkills, SKILL_CONFIDENCE_THRESHOLD } from "../../src/skills/picker.js";
import { jevReply } from "../helpers/jev-fake.js";

const NEXT_DESCRIPTION =
  "Next.js App Router expert guidance. Use when building, debugging, or architecting Next.js applications —\nrouting, Server Components, Server Actions and caching, well past any truncation length the picker used to apply.";

const SKILLS: SkillInfo[] = [
  { name: "superpowers:brainstorming", description: "Use before building a feature: explore the idea and the page design before writing code" },
  { name: "vercel:nextjs", description: NEXT_DESCRIPTION },
  { name: "brain-commit", description: "Writes the git commit message for a feature in the repository convention" },
  { name: "tailwind-design-system", description: "Tailwind CSS tokens for building a page design" },
];

const PROMPT = "brainstorm and build a new nextjs page feature with a tailwind design, then commit it";

function setup(scores: Record<string, number>, config: Partial<SkillsConfig> = {}) {
  const bodies: any[] = [];
  const ceilings: Array<[number, number]> = [];
  return {
    bodies,
    ceilings,
    deps: {
      projectDir: "/p",
      env: {},
      getToken: async () => "secret-token",
      discover: async () => SKILLS,
      loadTools: async () => [],
      skillsConfig: { ...DEFAULT_SKILLS_CONFIG, ...config },
      onCeiling: (cleared: number, ceiling: number) => void ceilings.push([cleared, ceiling]),
      fetchFn: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        return jevReply(body, scores);
      },
    },
  };
}

describe("multi-skill pick", () => {
  it("returns every skill the work needs, process and domain together, best first, in one request", async () => {
    const { deps, bodies } = setup({ "superpowers:brainstorming": 0.81, "vercel:nextjs": 0.93, "brain-commit": 0.2 });
    const lines = await pickSuggestions(PROMPT, deps);
    expect(bodies).toHaveLength(1);
    expect(lines.map((l) => l.split(" — ")[0])).toEqual(["Suggested skill: vercel:nextjs", "Suggested skill: superpowers:brainstorming"]);
  });

  it("asks one judgment per candidate and tells Jev several can apply", async () => {
    const { deps, bodies } = setup({});
    await pickSuggestions(PROMPT, deps);
    const questions = Object.entries(bodies[0]!.questions).filter(([key]) => key.startsWith("skill_"));
    expect(questions).toHaveLength(SKILLS.length);
    for (const [, question] of questions as Array<[string, { type: string; instructions: string }]>) {
      expect(question.type).toBe("noul");
      expect(question.instructions).toContain("Several skills can apply");
      expect(question.instructions).toContain("process");
    }
  });

  it("injects each picked skill's full description on one line", async () => {
    const { deps } = setup({ "vercel:nextjs": 0.9 });
    const line = await pickSkill(PROMPT, deps);
    expect(line).toBe(`Suggested skill: vercel:nextjs — ${NEXT_DESCRIPTION.replace("—\n", "— ")}`);
  });

  it("keeps the score floor: a skill just under it is left out", async () => {
    const { deps } = setup({ "vercel:nextjs": SKILL_CONFIDENCE_THRESHOLD - 0.01 });
    expect(await pickSkill(PROMPT, deps)).toBeNull();
  });

  it("cuts at the ceiling, keeps the best, and reports how many cleared", async () => {
    const all = Object.fromEntries(SKILLS.map((s, i) => [s.name, 0.95 - i * 0.05]));
    const { deps, ceilings } = setup(all, { pickCeiling: 2 });
    const lines = await pickSuggestions(PROMPT, deps);
    expect(lines.map((l) => l.split(" — ")[0])).toEqual(["Suggested skill: superpowers:brainstorming", "Suggested skill: vercel:nextjs"]);
    expect(ceilings).toEqual([[4, 2]]);
  });

  it("never asks about or suggests a general-use skill", async () => {
    const { deps, bodies } = setup({ "vercel:nextjs": 0.9, "brain-commit": 0.95 }, { general: ["brain-commit"] });
    const lines = await pickSuggestions(PROMPT, deps);
    expect(bodies[0]!.state.skills.map((s: { name: string }) => s.name)).not.toContain("brain-commit");
    expect(lines.join("\n")).not.toContain("brain-commit");
  });

  it("asks nothing about skills when the picker is off in skills.json", async () => {
    const { deps, bodies } = setup({ "vercel:nextjs": 0.9 }, { picker: false });
    expect(await pickSkill(PROMPT, deps)).toBeNull();
    expect(bodies).toHaveLength(0);
  });

  it("pickedSkills does not call the ceiling hook under it", () => {
    const seen: number[] = [];
    const picked = pickedSkills({ skill_0: { noul: 0.9 } }, SKILLS.slice(0, 2), 10, (n) => void seen.push(n));
    expect(picked.map((s) => s.name)).toEqual(["superpowers:brainstorming"]);
    expect(seen).toEqual([]);
  });
});

describe("prompt hook dedup with several picks", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-multi-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("skips a skill whose line is still in the live conversation and prints the others", async () => {
    const transcript = join(dir, "t.jsonl");
    const shown = "Suggested skill: vercel:nextjs — an older wording of the description";
    await writeFile(
      transcript,
      [
        { uuid: "u1", parentUuid: null, type: "user", message: { content: "earlier" } },
        { uuid: "a1", parentUuid: "u1", type: "attachment", attachment: { hookEvent: "UserPromptSubmit", stdout: shown } },
      ]
        .map((o) => JSON.stringify(o))
        .join("\n")
    );
    const printed: string[] = [];
    await runSuggest(JSON.stringify({ prompt: PROMPT, cwd: dir, transcript_path: transcript }), {
      print: (l) => printed.push(l),
      queryEmbedding: async () => null,
      taskContext: async () => null,
      upgradeNotice: async () => null,
      pick: async () => ["Suggested skill: vercel:nextjs — full", "Suggested skill: superpowers:brainstorming — full"],
    });
    expect(printed).toEqual(["Suggested skill: superpowers:brainstorming — full"]);
  });
});

describe("suggest --agent (delegation)", () => {
  const delegation = JSON.stringify({ description: "Build the landing page", prompt: PROMPT });

  it("prints the picked skills under a heading, from the description and prompt", async () => {
    const printed: string[] = [];
    const asked: string[] = [];
    const { deps } = setup({ "vercel:nextjs": 0.9, "superpowers:brainstorming": 0.85 });
    await runAgentSuggest(delegation, {
      print: (t) => printed.push(t),
      queryEmbedding: async () => null,
      pick: (text, d) => (asked.push(text), pickSkill(text, { ...d, ...deps })),
    });
    expect(asked[0]).toStartWith("Build the landing page\n\n");
    expect(printed).toHaveLength(1);
    expect(printed[0]!.split("\n")).toEqual([
      DELEGATION_SKILLS_HEADING,
      `Suggested skill: vercel:nextjs — ${NEXT_DESCRIPTION.replace("—\n", "— ")}`,
      `Suggested skill: superpowers:brainstorming — ${SKILLS[0]!.description}`,
    ]);
  });

  it("skips general-use skills", async () => {
    const printed: string[] = [];
    const { deps } = setup({ "vercel:nextjs": 0.9 }, { general: ["vercel:nextjs"] });
    await runAgentSuggest(delegation, { print: (t) => printed.push(t), queryEmbedding: async () => null, pick: (text, d) => pickSkill(text, { ...d, ...deps }) });
    expect(printed).toEqual([]);
  });

  it("prints nothing without a token, on a Jev failure, or on garbage input", async () => {
    const printed: string[] = [];
    const { deps } = setup({ "vercel:nextjs": 0.9 });
    const print = (t: string) => void printed.push(t);
    await runAgentSuggest(delegation, { print, queryEmbedding: async () => null, pick: (text, d) => pickSkill(text, { ...d, ...deps, getToken: async () => null }) });
    await runAgentSuggest(delegation, {
      print,
      queryEmbedding: async () => null,
      pick: (text, d) => pickSkill(text, { ...d, ...deps, fetchFn: async () => new Response("down", { status: 503 }) }),
    });
    await runAgentSuggest("{not json", { print, pick: async () => "Suggested skill: x — y" });
    expect(printed).toEqual([]);
  });
});
