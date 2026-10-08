import { describe, it, expect } from "bun:test";
import {
  DIFF_CAP_CHARS,
  commitCheckDecision,
  isSourcePath,
  isTestPath,
  parseGitCommit,
  parseMode,
  render,
  type CommitCheckContext,
} from "../../src/hooks/commit-check.js";
import type { ChoiceAnswer } from "../../src/typesafe/client.js";

const TOKEN = "tsk-secret-token-value";

const commit = (command: string, cwd = "/repo") => ({ tool_name: "Bash", tool_input: { command }, cwd });

function answer(yes: number, confidence = 0.95): ChoiceAnswer {
  return { type: "choice", choice: yes > 0.5 ? "yes" : "no", confidence, probabilities: { yes, no: 1 - yes } };
}

function testAnswer(needsTest: number, category = "business_rule"): ChoiceAnswer {
  return {
    type: "choice",
    choice: needsTest > 0.5 ? category : "no_test_needed",
    confidence: 0.95,
    probabilities: { [category]: needsTest, no_test_needed: 1 - needsTest },
  };
}

interface Fake {
  ctx: CommitCheckContext;
  asks: Array<{ token: string; state: any; questions: Record<string, any>; timeoutMs?: number }>;
  gitCalls: string[][];
}

function fake(opts: {
  names?: string;
  diff?: string;
  token?: string | null;
  mode?: "warn" | "block";
  answers?: Record<string, ChoiceAnswer> | null | ((q: Record<string, any>) => Record<string, ChoiceAnswer> | null);
  clock?: () => number;
}): Fake {
  const asks: Fake["asks"] = [];
  const gitCalls: string[][] = [];
  const ctx: CommitCheckContext = {
    token: async () => (opts.token === undefined ? TOKEN : opts.token),
    git: async (_cwd, args) => {
      gitCalls.push(args);
      return args.includes("--name-only") ? (opts.names ?? "src/a.ts\n") : (opts.diff ?? "+const x = 1;\n");
    },
    ask: async (token, state, questions, options) => {
      asks.push({ token, state, questions, timeoutMs: options?.timeoutMs });
      const a = typeof opts.answers === "function" ? opts.answers(questions) : opts.answers;
      if (a === null) return null;
      // Every question not mentioned reads as a confident "no".
      const out: Record<string, ChoiceAnswer> = {};
      for (const key of Object.keys(questions)) out[key] = a?.[key] ?? (key.startsWith("test") ? testAnswer(0.02) : answer(0.02));
      return out;
    },
    now: opts.clock ?? (() => 0),
    mode: opts.mode ?? "warn",
  };
  return { ctx, asks, gitCalls };
}

describe("parseGitCommit", () => {
  it.each([
    ["git commit -m 'x'"],
    ["git commit"],
    ["git -C ../other commit -m x"],
    ["git -c user.name=a commit -m x"],
    ["git add . && git commit -m x"],
    ["cd sub; git commit"],
    ["FOO=1 git commit -m x"],
    ["git status\ngit commit -m x"],
  ])("detects %s", (command) => {
    expect(parseGitCommit(command)).not.toBeNull();
  });

  it.each([
    ["git status"],
    ["git log --grep commit"],
    ["git commit-tree abc"],
    ["echo 'git commit'"],
    ["git push && echo commit"],
    ["gitk commit"],
    ["npm run commit"],
    ["git add commit.txt"],
  ])("ignores %s", (command) => {
    expect(parseGitCommit(command)).toBeNull();
  });

  it("collects -C directories and recognises -a / --all", () => {
    expect(parseGitCommit("git -C a -C b commit -m x")).toEqual({ dirs: ["a", "b"], all: false });
    expect(parseGitCommit("git commit -am 'x'")?.all).toBe(true);
    expect(parseGitCommit("git commit --all -m x")?.all).toBe(true);
    expect(parseGitCommit("git commit --allow-empty -m x")?.all).toBe(false);
  });

  it("keeps an operator inside a quoted message from splitting the command", () => {
    expect(parseGitCommit('git commit -m "fix a && b"')).not.toBeNull();
  });
});

describe("path classification", () => {
  it("separates tests from sources", () => {
    expect(isTestPath("tests/hooks/a.test.ts")).toBe(true);
    expect(isTestPath("src/a.spec.tsx")).toBe(true);
    expect(isTestPath("pkg/a_test.go")).toBe(true);
    expect(isTestPath("src/a.ts")).toBe(false);
    expect(isSourcePath("src/a.ts")).toBe(true);
    expect(isSourcePath("README.md")).toBe(false);
    expect(isSourcePath("src/a.test.ts")).toBe(false);
  });
});

describe("commitCheckDecision", () => {
  it("stays silent for anything that is not a Bash git commit", async () => {
    const f = fake({});
    expect(await commitCheckDecision(commit("git status"), f.ctx)).toEqual({ block: false });
    expect(await commitCheckDecision({ tool_name: "Edit", tool_input: { command: "git commit" } }, f.ctx)).toEqual({ block: false });
    expect(await commitCheckDecision(null, f.ctx)).toEqual({ block: false });
    expect(f.asks).toHaveLength(0);
    expect(f.gitCalls).toHaveLength(0);
  });

  it("produces no output at all for a routine change, and sends one ask", async () => {
    const f = fake({ names: "src/a.ts\ntests/a.test.ts\n" });
    expect(await commitCheckDecision(commit("git commit -m x"), f.ctx)).toEqual({ block: false });
    expect(f.asks).toHaveLength(1);
  });

  it("escalates a risk above 0.8 and names it", async () => {
    const f = fake({ answers: { security: answer(0.93) } });
    const d = await commitCheckDecision(commit("git commit -m x"), f.ctx);
    expect(d.block).toBe(false);
    expect(d.message).toContain("independent deep review");
    expect(d.message).toContain("security or permission boundary");
    expect(d.message).toContain("0.93");
  });

  it("does not escalate at exactly 0.8", async () => {
    const f = fake({ answers: { security: answer(0.8) } });
    expect((await commitCheckDecision(commit("git commit -m x"), f.ctx)).message).toBeUndefined();
  });

  it("block mode blocks the review escalation only", async () => {
    const risky = fake({ mode: "block", answers: { destructive: answer(0.9) } });
    expect((await commitCheckDecision(commit("git commit -m x"), risky.ctx)).block).toBe(true);

    const untested = fake({ mode: "block", answers: { test0: testAnswer(0.95) } });
    const d = await commitCheckDecision(commit("git commit -m x"), untested.ctx);
    expect(d.block).toBe(false);
    expect(d.message).toContain("src/a.ts");
  });

  it("names the untested files and their category", async () => {
    const f = fake({
      names: "src/pricing.ts\nsrc/button.tsx\n",
      answers: { test0: testAnswer(0.97, "business_rule"), test1: testAnswer(0.1) },
    });
    const d = await commitCheckDecision(commit("git commit -m x"), f.ctx);
    expect(d.block).toBe(false);
    expect(d.message).toContain("src/pricing.ts (a business rule or calculation)");
    expect(d.message).not.toContain("src/button.tsx");
  });

  it("asks no test question when any test is staged, or when only non-source files changed", async () => {
    const withTest = fake({ names: "src/a.ts\ntests/a.test.ts\n" });
    await commitCheckDecision(commit("git commit -m x"), withTest.ctx);
    expect(Object.keys(withTest.asks[0]!.questions).some((k) => k.startsWith("test"))).toBe(false);

    const docs = fake({ names: "README.md\n" });
    await commitCheckDecision(commit("git commit -m x"), docs.ctx);
    expect(Object.keys(docs.asks[0]!.questions).some((k) => k.startsWith("test"))).toBe(false);
  });

  it("reports review and coverage together from the single ask", async () => {
    const f = fake({ answers: { contract: answer(0.9), test0: testAnswer(0.9, "data_contract") } });
    const d = await commitCheckDecision(commit("git commit -m x"), f.ctx);
    expect(f.asks).toHaveLength(1);
    expect(d.message).toContain("public contract");
    expect(d.message).toContain("data mapper or a contract");
  });

  it("truncates the diff to the cap", async () => {
    const f = fake({ diff: "+".padEnd(DIFF_CAP_CHARS * 2, "x") });
    await commitCheckDecision(commit("git commit -m x"), f.ctx);
    expect(f.asks[0]!.state.diff.length).toBeLessThan(DIFF_CAP_CHARS + 50);
    expect(f.asks[0]!.state.diff).toContain("[diff truncated]");
  });

  it("diffs HEAD for `commit -a` and runs git in the -C directory", async () => {
    const f = fake({});
    const cwds: string[] = [];
    const inner = f.ctx.git;
    f.ctx.git = async (cwd, args) => (cwds.push(cwd), inner(cwd, args));
    await commitCheckDecision(commit("git -C sub commit -am x", "/repo"), f.ctx);
    expect(cwds[0]).toBe("/repo/sub");
    expect(f.gitCalls[0]).toContain("HEAD");
  });

  describe("fails open", () => {
    it("without a token, and without touching git or the network", async () => {
      const f = fake({ token: null, answers: { security: answer(0.99) } });
      expect(await commitCheckDecision(commit("git commit -m x"), f.ctx)).toEqual({ block: false });
      expect(f.asks).toHaveLength(0);
      expect(f.gitCalls).toHaveLength(0);
    });

    it("on an empty staged diff", async () => {
      const f = fake({ diff: "  \n", names: "" });
      expect(await commitCheckDecision(commit("git commit -m x"), f.ctx)).toEqual({ block: false });
      expect(f.asks).toHaveLength(0);
    });

    it("when git fails", async () => {
      const f = fake({});
      f.ctx.git = async () => null;
      expect(await commitCheckDecision(commit("git commit -m x"), f.ctx)).toEqual({ block: false });
    });

    it("when Jev returns null (unavailable or timed out) on a benign diff", async () => {
      const f = fake({ answers: null });
      expect(await commitCheckDecision(commit("git commit -m x"), f.ctx)).toEqual({ block: false });
    });

    it("when ask throws", async () => {
      const f = fake({});
      f.ctx.ask = async () => {
        throw new Error("boom");
      };
      expect(await commitCheckDecision(commit("git commit -m x"), f.ctx)).toEqual({ block: false });
    });

    it("when the hook budget is already spent", async () => {
      let t = 0;
      const f = fake({ clock: () => (t += 5000) });
      expect(await commitCheckDecision(commit("git commit -m x"), f.ctx)).toEqual({ block: false });
      expect(f.asks).toHaveLength(0);
    });
  });

  describe("when Jev cannot judge a risky-looking diff", () => {
    it("escalates on null, but never blocks even in block mode", async () => {
      const f = fake({ answers: null, mode: "block", diff: "+const secret = readToken();\n" });
      const d = await commitCheckDecision(commit("git commit -m x"), f.ctx);
      expect(d.block).toBe(false);
      expect(d.message).toContain("independent deep review");
      expect(d.message).toContain("unavailable");
    });

    it("escalates on low confidence", async () => {
      const f = fake({ answers: { security: answer(0.4, 0.2) }, diff: "-DROP TABLE users;\n" });
      const d = await commitCheckDecision(commit("git commit -m x"), f.ctx);
      expect(d.message).toContain("unsure");
    });

    it("stays silent on low confidence for a benign diff", async () => {
      const f = fake({ answers: { security: answer(0.4, 0.2) } });
      expect((await commitCheckDecision(commit("git commit -m x"), f.ctx)).message).toBeUndefined();
    });
  });

  it("gives Jev at most 3s and only what is left of the hook budget", async () => {
    const f = fake({});
    await commitCheckDecision(commit("git commit -m x"), f.ctx);
    expect(f.asks[0]!.timeoutMs).toBe(3000);

    let t = 0;
    const slow = fake({ clock: () => ((t += 2000), t) });
    await commitCheckDecision(commit("git commit -m x"), slow.ctx);
    expect(slow.asks[0]!.timeoutMs).toBeLessThan(3000);
  });

  it("never puts the token in a message", async () => {
    const f = fake({
      answers: { security: answer(0.99), test0: testAnswer(0.99) },
      diff: `+const t = "${TOKEN}";\n`,
    });
    const d = await commitCheckDecision(commit("git commit -m x"), f.ctx);
    expect(d.message).toBeDefined();
    expect(d.message).not.toContain(TOKEN);
    expect(JSON.stringify(f.asks[0]!.state)).not.toContain("Bearer");
  });
});

describe("parseMode", () => {
  it("is warn unless the file says block", () => {
    expect(parseMode(null)).toBe("warn");
    expect(parseMode("not json")).toBe("warn");
    expect(parseMode('{"mode":"warn"}')).toBe("warn");
    expect(parseMode('{"mode":"loud"}')).toBe("warn");
    expect(parseMode('{"mode":"block"}')).toBe("block");
  });
});

describe("render", () => {
  it("block mode exits 2 with the reason on stderr", () => {
    expect(render({ block: true, message: "review it" })).toEqual({ code: 2, stdout: "", stderr: "review it\n" });
  });

  it("warn mode exits 0 with additionalContext on stdout", () => {
    const out = render({ block: false, message: "careful" });
    expect(out.code).toBe(0);
    expect(out.stderr).toBe("");
    expect(JSON.parse(out.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "careful" },
    });
  });

  it("prints nothing for a routine commit", () => {
    expect(render({ block: false })).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});

describe("execute (process)", () => {
  async function run(stdin: unknown, env: Record<string, string> = {}) {
    const proc = Bun.spawn(["bun", "src/cli.ts", "commit-check"], {
      stdin: new Blob([typeof stdin === "string" ? stdin : JSON.stringify(stdin)]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: "/nonexistent-home", TYPESAFE_API_KEY: "", ...env },
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  }

  it("exits 0 silently for garbage stdin, a non-commit, and a commit without a token", async () => {
    for (const stdin of ["not json", commit("git status"), commit("git commit -m x")]) {
      const r = await run(stdin);
      expect(r).toEqual({ out: "", err: "", code: 0 });
    }
  });
});
