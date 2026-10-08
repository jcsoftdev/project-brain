import { describe, expect, it } from "bun:test";
import { runWithSkillPick } from "../../src/commands/search.js";
import {
  MAX_SKILL_CANDIDATES,
  pickSkill,
  prefilterSkills,
  SKILL_CONFIDENCE_THRESHOLD,
} from "../../src/skills/picker.js";
import type { SkillInfo } from "../../src/skills/discovery.js";

const SKILLS: SkillInfo[] = [
  { name: "brain-commit", description: "Writes a git commit message in the repository convention" },
  { name: "brain-audit", description: "Audit the codebase for dead code and security problems" },
  { name: "tailwind", description: "Tailwind CSS design tokens and dark mode" },
];

const PROMPT = "please write the git commit message for these changes";

function jevResponse(choice: string, p: number): Response {
  return new Response(
    JSON.stringify({ answers: { pick: { choice, confidence: p, probabilities: { [choice]: p, none: 1 - p } } } })
  );
}

function deps(over: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; body: any }> = [];
  return {
    calls,
    deps: {
      projectDir: "/p",
      env: {},
      getToken: async () => "secret-token",
      discover: async () => SKILLS,
      fetchFn: async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return jevResponse("brain-commit", 0.93);
      },
      ...over,
    },
  };
}

describe("prefilterSkills", () => {
  it("keeps only skills sharing a word with the prompt, best overlap first", () => {
    const out = prefilterSkills("audit the git commit message", SKILLS);
    expect(out.map((s) => s.name)).toEqual(["brain-commit", "brain-audit"]);
  });

  it("returns nothing when no word overlaps", () => {
    expect(prefilterSkills("zzz qqq", SKILLS)).toEqual([]);
  });

  it("caps the shortlist", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `s${i}`, description: "commit helper" }));
    expect(prefilterSkills("commit", many)).toHaveLength(MAX_SKILL_CANDIDATES);
  });
});

describe("pickSkill", () => {
  it("returns a suggestion line for a confident pick, with the prompt and candidates in state", async () => {
    const { deps: d, calls } = deps();
    const line = await pickSkill(PROMPT, d);
    expect(line).toStartWith("Suggested skill: brain-commit — ");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.state.prompt).toBe(PROMPT);
    expect(Object.keys(calls[0]!.body.questions.pick.criteria)).toContain("none");
  });

  it("truncates descriptions sent to Jev", async () => {
    const long = { name: "commit-long", description: `commit ${"x".repeat(1000)}` };
    const { deps: d, calls } = deps({ discover: async () => [long] });
    await pickSkill(PROMPT, d);
    expect(calls[0]!.body.state.skills[0].description.length).toBeLessThan(300);
  });

  it("stays silent below the confidence threshold", async () => {
    const p = SKILL_CONFIDENCE_THRESHOLD - 0.05;
    const { deps: d } = deps({ fetchFn: async () => jevResponse("brain-commit", p) });
    expect(await pickSkill(PROMPT, d)).toBeNull();
  });

  it("stays silent when none wins", async () => {
    const { deps: d } = deps({ fetchFn: async () => jevResponse("none", 0.95) });
    expect(await pickSkill(PROMPT, d)).toBeNull();
  });

  it("stays silent without a token and makes no request", async () => {
    const { deps: d, calls } = deps({ getToken: async () => null });
    expect(await pickSkill(PROMPT, d)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("stays silent on a null answer", async () => {
    const { deps: d } = deps({ fetchFn: async () => new Response("nope", { status: 500 }) });
    expect(await pickSkill(PROMPT, d)).toBeNull();
  });

  it("stays silent on a timeout", async () => {
    const { deps: d } = deps({
      fetchFn: async () => {
        throw Object.assign(new Error("slow"), { name: "TimeoutError" });
      },
    });
    expect(await pickSkill(PROMPT, d)).toBeNull();
  });

  it("skips trivial prompts without calling anything", async () => {
    const { deps: d, calls } = deps();
    expect(await pickSkill("ok", d)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("skips when no candidate overlaps the prompt", async () => {
    const { deps: d, calls } = deps();
    expect(await pickSkill("zzz qqq xylophone", d)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("is disabled by BRAIN_SKILL_PICKER=0", async () => {
    const { deps: d, calls } = deps({ env: { BRAIN_SKILL_PICKER: "0" } });
    expect(await pickSkill(PROMPT, d)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("never puts the token in the returned line", async () => {
    const { deps: d } = deps();
    expect(await pickSkill(PROMPT, d)).not.toContain("secret-token");
  });
});

describe("runWithSkillPick", () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it("overlaps search and pick: elapsed is about max, not the sum", async () => {
    const printed: string[] = [];
    const start = performance.now();
    await runWithSkillPick(
      () => sleep(120),
      async () => {
        await sleep(120);
        return "Suggested skill: x — y";
      },
      (l) => printed.push(l)
    );
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
    expect(printed).toEqual(["Suggested skill: x — y"]);
  });

  it("prints the suggestion after the retrieved context", async () => {
    const order: string[] = [];
    await runWithSkillPick(
      async () => {
        order.push("search");
      },
      async () => "line",
      () => order.push("pick")
    );
    expect(order).toEqual(["search", "pick"]);
  });

  it("gives up on a hung pick at the budget and prints nothing", async () => {
    const printed: string[] = [];
    const start = performance.now();
    await runWithSkillPick(
      async () => {},
      () => new Promise<string | null>(() => {}),
      (l) => printed.push(l),
      { graceMs: 50 }
    );
    expect(performance.now() - start).toBeLessThan(200);
    expect(printed).toEqual([]);
  });

  it("prints nothing when the pick rejects or yields null", async () => {
    const printed: string[] = [];
    await runWithSkillPick(async () => {}, async () => { throw new Error("x"); }, (l) => printed.push(l));
    await runWithSkillPick(async () => {}, async () => null, (l) => printed.push(l));
    expect(printed).toEqual([]);
  });

  describe("late shared vector (live-hook regression)", () => {
    const delayed = <T,>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
    // Timings are the live ones scaled ~1/10: vector ~1.4s -> 140ms, search ~1.6s -> 160ms.
    const timing = { graceMs: 25, jevBudgetMs: 100, capMs: 1000 };

    function setup(vectorMs: number) {
      const { deps: d } = deps({
        jevTimeoutMs: 100,
        fetchFn: async () => {
          await sleep(40);
          return jevResponse("brain-commit", 0.95);
        },
      });
      const vector = delayed(vectorMs, null);
      return { d: { ...d, queryEmbedding: () => vector }, vector };
    }

    it("still prints when the vector arrives after most of the hook and search ends later", async () => {
      const { d, vector } = setup(140);
      const printed: string[] = [];
      await runWithSkillPick(() => sleep(160), () => pickSkill(PROMPT, d), (l) => printed.push(l), {
        ...timing,
        vectorSettled: vector,
      });
      expect(printed).toHaveLength(1);
      expect(printed[0]).toStartWith("Suggested skill: brain-commit");
    });

    it("keeps a hung pick bounded when search finishes early", async () => {
      const printed: string[] = [];
      const vector = delayed(5, null);
      const start = performance.now();
      await runWithSkillPick(
        () => sleep(10),
        () => new Promise<string | null>(() => {}),
        (l) => printed.push(l),
        { ...timing, vectorSettled: vector }
      );
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(180); // vector (5) + jev budget (100), not the cap
      expect(printed).toEqual([]);
    });

    it("never waits past the cap", async () => {
      const start = performance.now();
      await runWithSkillPick(
        () => sleep(10),
        () => new Promise<string | null>(() => {}),
        () => {},
        { graceMs: 25, jevBudgetMs: 5000, capMs: 80, vectorSettled: delayed(5, null) }
      );
      expect(performance.now() - start).toBeLessThan(150);
    });

    it("falls back to keywords immediately when the vector is null", async () => {
      const { deps: d } = deps({ jevTimeoutMs: 100 });
      const t0 = performance.now();
      const line = await pickSkill(PROMPT, { ...d, queryEmbedding: async () => null });
      expect(line).toStartWith("Suggested skill:");
      expect(performance.now() - t0).toBeLessThan(50);
    });
  });
});
