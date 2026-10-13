import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillInfo } from "../../src/skills/discovery.js";
import { pickSkill, pickSuggestions, prefilterTools, toolPickerEnabled, SKILL_CONFIDENCE_THRESHOLD } from "../../src/skills/picker.js";
import { modelsWithVectors, warmVectors } from "../../src/skills/semantic.js";
import type { ToolEntry } from "../../src/toolcatalog/live.js";
import { rankToolsSemantic, TOOL_SPEC } from "../../src/toolcatalog/shortlist.js";

const SKILLS: SkillInfo[] = [{ name: "brain-commit", description: "Writes a git commit message in the repository convention" }];
const TOOLS: ToolEntry[] = [
  { name: "mcp__claude_ai_Slack__slack_send_message", server: "claude_ai_Slack", description: "Slack: slack send message to a channel" },
  { name: "mcp__figma__authenticate", server: "figma", description: "Figma: authenticate" },
];

const PROMPT = "send a slack message and write the git commit message";

type Answers = Record<string, { choice: string; p: number }>;

function jev(answers: Answers): Response {
  return new Response(
    JSON.stringify({
      answers: Object.fromEntries(
        Object.entries(answers).map(([k, v]) => [k, { choice: v.choice, confidence: v.p, probabilities: { [v.choice]: v.p, none: 1 - v.p } }])
      ),
    })
  );
}

function setup(answers: Answers, over: Record<string, unknown> = {}) {
  const calls: Array<{ body: any }> = [];
  return {
    calls,
    deps: {
      projectDir: "/p",
      env: {},
      getToken: async () => "secret-token",
      discover: async () => SKILLS,
      loadTools: async () => TOOLS,
      fetchFn: async (_url: string, init: RequestInit) => {
        calls.push({ body: JSON.parse(init.body as string) });
        return jev(answers);
      },
      ...over,
    },
  };
}

const BOTH: Answers = {
  pick: { choice: "brain-commit", p: 0.9 },
  tool: { choice: "mcp__claude_ai_Slack__slack_send_message", p: 0.92 },
};

describe("pickSuggestions", () => {
  it("asks skills and tools in ONE request and returns both lines", async () => {
    const { deps, calls } = setup(BOTH);
    const lines = await pickSuggestions(PROMPT, deps);
    expect(calls).toHaveLength(1);
    const { questions, state } = calls[0]!.body;
    expect(Object.keys(questions).sort()).toEqual(["pick", "tool"]);
    expect(Object.keys(questions.tool.criteria)).toContain("none");
    expect(Object.keys(questions.pick.criteria)).toContain("none");
    expect(state.tools.map((t: { name: string }) => t.name)).toContain("mcp__claude_ai_Slack__slack_send_message");
    expect(lines).toEqual([
      expect.stringMatching(/^Suggested skill: brain-commit — /),
      "Suggested tool: mcp__claude_ai_Slack__slack_send_message — Slack: slack send message to a channel",
    ]);
  });

  it("truncates the tool description in the line to 120 characters", async () => {
    const long: ToolEntry = { name: "mcp__s__slack_post", server: "s", description: `slack ${"x".repeat(400)}` };
    const { deps } = setup({ tool: { choice: long.name, p: 0.95 } }, { loadTools: async () => [long] });
    const [line] = await pickSuggestions("post to slack", deps);
    expect(line!.length).toBeLessThan("Suggested tool: ".length + long.name.length + 3 + 121);
  });

  it("sends only the tool question when no skill is shortlisted", async () => {
    const { deps, calls } = setup({ tool: BOTH.tool! }, { discover: async () => [] });
    const lines = await pickSuggestions(PROMPT, deps);
    expect(Object.keys(calls[0]!.body.questions)).toEqual(["tool"]);
    expect(calls[0]!.body.state.skills).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("Suggested tool: ");
  });

  it("sends only the skill question when no tool is shortlisted", async () => {
    const { deps, calls } = setup({ pick: BOTH.pick! }, { loadTools: async () => [] });
    const lines = await pickSuggestions(PROMPT, deps);
    expect(Object.keys(calls[0]!.body.questions)).toEqual(["pick"]);
    expect(lines).toHaveLength(1);
  });

  it("makes no call when neither shortlist has candidates", async () => {
    const { deps, calls } = setup(BOTH, { discover: async () => [], loadTools: async () => [] });
    expect(await pickSuggestions(PROMPT, deps)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("applies the 0.7 threshold and none per question", async () => {
    const { deps } = setup({
      pick: { choice: "none", p: 0.99 },
      tool: { choice: TOOLS[0]!.name, p: SKILL_CONFIDENCE_THRESHOLD + 0.05 },
    });
    expect(await pickSuggestions(PROMPT, deps)).toEqual([expect.stringMatching(/^Suggested tool: /)]);

    const low = setup({ pick: BOTH.pick!, tool: { choice: TOOLS[0]!.name, p: SKILL_CONFIDENCE_THRESHOLD - 0.05 } });
    expect(await pickSuggestions(PROMPT, low.deps)).toEqual([expect.stringMatching(/^Suggested skill: /)]);
  });

  it("ignores a tool label that is not in the shortlist", async () => {
    const { deps } = setup({ tool: { choice: "mcp__made__up", p: 0.99 } }, { discover: async () => [] });
    expect(await pickSuggestions(PROMPT, deps)).toEqual([]);
  });

  it("stays silent on a failed request and never leaks the token", async () => {
    const { deps } = setup(BOTH, { fetchFn: async () => new Response("no", { status: 500 }) });
    expect(await pickSuggestions(PROMPT, deps)).toEqual([]);
    expect(JSON.stringify(await pickSuggestions(PROMPT, setup(BOTH).deps))).not.toContain("secret-token");
  });

  it("a throwing catalog loader costs only the tool question", async () => {
    const { deps } = setup(BOTH, {
      loadTools: async () => {
        throw new Error("boom");
      },
    });
    expect(await pickSuggestions(PROMPT, deps)).toEqual([expect.stringMatching(/^Suggested skill: /)]);
  });

  it("sends the skill question alone when the tool shortlist misses its budget", async () => {
    const { deps, calls } = setup(BOTH, {
      toolBudgetMs: 20,
      loadTools: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return TOOLS;
      },
    });
    const lines = await pickSuggestions(PROMPT, deps);
    expect(Object.keys(calls[0]!.body.questions)).toEqual(["pick"]);
    expect(lines).toEqual([expect.stringMatching(/^Suggested skill: /)]);
  });

  it("BRAIN_TOOL_PICKER=0 drops the tool question but keeps skills", async () => {
    const { deps, calls } = setup(BOTH, { env: { BRAIN_TOOL_PICKER: "0" } });
    const lines = await pickSuggestions(PROMPT, deps);
    expect(Object.keys(calls[0]!.body.questions)).toEqual(["pick"]);
    expect(lines).toEqual([expect.stringMatching(/^Suggested skill: /)]);
  });

  it("BRAIN_SKILL_PICKER=0 drops the skill question but keeps tools", async () => {
    const { deps, calls } = setup(BOTH, { env: { BRAIN_SKILL_PICKER: "0" } });
    const lines = await pickSuggestions(PROMPT, deps);
    expect(Object.keys(calls[0]!.body.questions)).toEqual(["tool"]);
    expect(lines).toEqual([expect.stringMatching(/^Suggested tool: /)]);
  });

  it("both opt-outs → no call; the catalog is not even read", async () => {
    let loaded = false;
    const { deps, calls } = setup(BOTH, {
      env: { BRAIN_SKILL_PICKER: "0", BRAIN_TOOL_PICKER: "0" },
      loadTools: async () => {
        loaded = true;
        return TOOLS;
      },
    });
    expect(await pickSuggestions(PROMPT, deps)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(loaded).toBe(false);
  });
});

describe("pickSkill keeps its skill-only contract", () => {
  it("never asks the tool question", async () => {
    const { deps, calls } = setup(BOTH);
    expect(await pickSkill(PROMPT, deps)).toStartWith("Suggested skill: ");
    expect(Object.keys(calls[0]!.body.questions)).toEqual(["pick"]);
  });
});

describe("tool shortlist and flags", () => {
  it("keyword fallback matches tool-name words and drops non-overlapping tools", () => {
    expect(prefilterTools("manda un mensaje a slack", TOOLS).map((t) => t.server)).toEqual(["claude_ai_Slack"]);
    expect(prefilterTools("zzz qqq", TOOLS)).toEqual([]);
  });

  it("toolPickerEnabled is independent of the skill flag", () => {
    expect(toolPickerEnabled({})).toBe(true);
    expect(toolPickerEnabled({ BRAIN_TOOL_PICKER: "0" })).toBe(false);
    expect(toolPickerEnabled({ BRAIN_SKILL_PICKER: "0" })).toBe(true);
  });
});

describe("tool vector store", () => {
  let dir: string;
  let embedded: number;
  const vec = (t: string) => (t.startsWith("mcp__claude_ai_Slack") ? [1, 0] : [0, 1]);
  const embeddings = {
    dim: 2,
    model: "m:1",
    isAvailable: async () => true,
    embed: async (texts: string[]) => {
      embedded += texts.length;
      return texts.map(vec);
    },
  };
  const query = { embeddings, vector: [1, 0] };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "toolvec-"));
    embedded = 0;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("never embeds on the hook path: ranks only with vectors the background warm wrote", async () => {
    expect(await rankToolsSemantic(TOOLS, query, 12, dir)).toBeNull();
    expect(embedded).toBe(0);
    expect(await readdir(dir)).toEqual([]);

    await warmVectors(TOOLS, TOOL_SPEC, embeddings, dir);
    expect(embedded).toBe(2);
    expect(await readdir(dir)).toEqual(["tool-vectors-m_1.bin"]);
    expect((await rankToolsSemantic(TOOLS, query, 12, dir))!.map((t) => t.server)).toEqual(["claude_ai_Slack"]);
    expect(embedded).toBe(2);
  });

  it("re-embeds only changed descriptions and prunes vectors of tools that are gone", async () => {
    await warmVectors(TOOLS, TOOL_SPEC, embeddings, dir);
    await warmVectors(TOOLS, TOOL_SPEC, embeddings, dir);
    expect(embedded).toBe(2);
    await warmVectors([TOOLS[0]!, { ...TOOLS[1]!, description: "changed" }], TOOL_SPEC, embeddings, dir);
    expect(embedded).toBe(3);
    await warmVectors([TOOLS[0]!], TOOL_SPEC, embeddings, dir);
    expect(embedded).toBe(3);
    // The dropped tool no longer ranks.
    expect((await rankToolsSemantic(TOOLS, query, 12, dir))!.map((t) => t.server)).toEqual(["claude_ai_Slack"]);
    expect(await modelsWithVectors("tool-vectors", dir)).toEqual(["m:1"]);
  });

  it("a truncated vector file is neither ranked from nor overwritten", async () => {
    await warmVectors(TOOLS, TOOL_SPEC, embeddings, dir);
    const file = join(dir, "tool-vectors-m_1.bin");
    const whole = await readFile(file);
    await writeFile(file, whole.subarray(0, whole.length - 5));
    const truncated = await readFile(file);

    expect(await rankToolsSemantic(TOOLS, query, 12, dir)).toBeNull();
    await warmVectors(TOOLS, TOOL_SPEC, embeddings, dir);
    expect(Buffer.compare(await readFile(file), truncated)).toBe(0);
    expect(embedded).toBe(2);
  });

  it("a truncated JSON skill vector file is left untouched too", async () => {
    const { rankSkillsSemantic } = await import("../../src/skills/semantic.js");
    const file = join(dir, "skill-vectors-m_1.json");
    await writeFile(file, '{"a|0":[0.1,0.');
    expect(await rankSkillsSemantic([{ name: "a", description: "d" }], query, 12, dir)).toBeNull();
    expect(await readFile(file, "utf-8")).toBe('{"a|0":[0.1,0.');
    expect(embedded).toBe(0);
  });

  it("writes cache files atomically: no temp files are left behind", async () => {
    await warmVectors(TOOLS, TOOL_SPEC, embeddings, dir);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
