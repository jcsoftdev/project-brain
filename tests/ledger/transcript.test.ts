import { describe, expect, it } from "bun:test";
import { usageSignal } from "../../src/ledger/signal.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpServerKey, mentions, parseInjection, parseTranscript, parseTranscriptFile } from "../../src/ledger/transcript.js";
import { compactBoundary, injection, instructionsDelta, instructionsRemoved, toolResult, toolsDelta, toolUse, transcript, userPrompt } from "./fixtures.js";

const o = { sessionId: "s-1", cwd: "/work/app", at: "2026-11-10T10:00:00.000Z" };
const later = { ...o, at: "2026-11-10T10:05:00.000Z" };

describe("parseInjection", () => {
  it("reads source, range and score of each hit and counts its snippet lines toward it", () => {
    const hits = parseInjection(
      "<project-brain: relevant context for this prompt>\n- src/a.ts › run (L3-9) [score 0.81]\n  one\n  two\n- docs/b c.md [score 0.66]\n  three\n</project-brain>"
    );
    expect(hits.map((h) => [h.source, h.startLine, h.endLine, h.score])).toEqual([
      ["src/a.ts", 3, 9, 0.81],
      ["docs/b c.md", undefined, undefined, 0.66],
    ]);
    expect(hits[0]!.chars).toBe("- src/a.ts › run (L3-9) [score 0.81]\n  one\n  two\n".length);
  });
});

describe("mentions", () => {
  it("matches a path whole or as the tail of a longer one, never a prefix of another name", () => {
    expect(mentions("sed -n 1,20p /work/app/src/a.ts", "src/a.ts")).toBe(true);
    expect(mentions("rg foo src/a.ts:12", "src/a.ts")).toBe(true);
    expect(mentions("cat src/a.tsx", "src/a.ts")).toBe(false);
    expect(mentions("cat lib/xsrc/a.ts", "src/a.ts")).toBe(false);
  });
});

describe("parseTranscript", () => {
  it("records each injection and marks a hit used only by what happened after it", () => {
    const pb = "toolu_pb";
    const text = transcript([
      userPrompt(o, "how does the runner work"),
      toolUse(o, "Read", { file_path: "/work/app/src/early.ts" }),
      injection(o, [
        { source: "src/early.ts", score: 0.7 },
        { source: "src/read.ts", symbol: "read", lines: [1, 5], score: 0.9 },
        { source: "src/edited.ts", score: 0.8 },
        { source: "src/shell.ts", score: 0.66 },
        { source: "src/brain.ts", score: 0.75 },
        { source: "src/untouched.ts", score: 0.68 },
      ]),
      toolUse(later, "Read", { file_path: "/work/app/.claude/worktrees/x/src/read.ts" }),
      toolUse(later, "Edit", { file_path: "/work/app/src/edited.ts", old_string: "a", new_string: "b" }),
      toolUse(later, "Bash", { command: "sed -n 1,40p src/shell.ts" }),
      toolUse(later, "mcp__project-brain__expand_context", { chunk_id: "abc-1-0" }, pb),
      toolResult(later, pb, [{ type: "text", text: JSON.stringify({ source: "src/brain.ts", content: "..." }) }]),
    ]);
    const ledger = parseTranscript(text);

    expect(ledger.sessionId).toBe("s-1");
    expect(ledger.cwd).toBe("/work/app");
    expect(ledger.firstAt).toBe(Date.parse(o.at));
    expect(ledger.lastAt).toBe(Date.parse(later.at));
    expect(ledger.injections).toHaveLength(1);
    expect(ledger.injections[0]!.hits).toHaveLength(6);
    const used = Object.fromEntries(ledger.hits.map((h) => [h.source, h.used]));
    expect(used).toEqual({
      "src/early.ts": [],
      "src/read.ts": ["read"],
      "src/edited.ts": ["edit"],
      "src/shell.ts": ["bash"],
      "src/brain.ts": ["project-brain"],
      "src/untouched.ts": [],
    });
  });

  it("counts a hit injected twice once, with its best score, and usage after its first injection", () => {
    const text = transcript([
      injection(o, [{ source: "src/a.ts", lines: [1, 2], score: 0.66 }]),
      toolUse(o, "Read", { file_path: "/work/app/src/a.ts" }),
      injection(later, [{ source: "src/a.ts", lines: [1, 2], score: 0.72 }]),
    ]);
    const { hits, injections } = parseTranscript(text);
    expect(injections).toHaveLength(2);
    expect(hits).toEqual([{ source: "src/a.ts", startLine: 1, score: 0.72, injections: 2, used: ["read"] }]);
  });

  it("keys a server's tools and its instructions under one name, as Claude Code spells it in tool names", () => {
    const cases: Array<[string, string, string]> = [
      ["plugin:engram:engram", "mcp__plugin_engram_engram__mem_save", "plugin_engram_engram"],
      ["claude.ai Claude Docs", "mcp__claude_ai_Claude_Docs__create", "claude_ai_Claude_Docs"],
      ["chrome-devtools", "mcp__chrome-devtools__click", "chrome-devtools"],
      ["project-brain", "mcp__project-brain__search_context", "project-brain"],
    ];
    for (const [display, tool, key] of cases) {
      expect(mcpServerKey(display)).toBe(key);
      const { mcp } = parseTranscript(transcript([toolsDelta(o, [tool]), instructionsDelta(o, { [display]: "how to use it" })]));
      expect(Object.keys(mcp)).toEqual([key]);
      expect(mcp[key]).toEqual({ tools: 1, chars: tool.length + 1 + "how to use it".length });
    }
  });

  it("counts tools added then removed within a stretch, since their text stays until a compaction", () => {
    const tools = ["mcp__alpha__one", "mcp__alpha__two", "mcp__alpha__three"];
    const text = transcript([
      toolsDelta(o, ["WebFetch", ...tools]),
      instructionsDelta(o, { alpha: "use alpha well" }),
      toolsDelta(later, [], tools),
      instructionsRemoved(later, ["alpha"]),
    ]);
    const { mcp } = parseTranscript(text);
    expect(mcp).toEqual({ alpha: { tools: 3, chars: tools.reduce((n, t) => n + t.length + 1, 0) + "use alpha well".length } });
  });

  it("carries over only what is still live after a compaction", () => {
    const text = transcript([
      toolsDelta(o, ["mcp__alpha__one", "mcp__beta__x"]),
      toolsDelta(o, [], ["mcp__beta__x"]),
      compactBoundary(later),
      toolsDelta(later, ["mcp__gamma__big_tool_name_that_makes_this_stretch_the_largest"]),
    ]);
    const { mcp } = parseTranscript(text);
    expect(Object.keys(mcp).sort()).toEqual(["alpha", "gamma"]);
  });

  it("counts the set once across compactions, which re-announce it, keeping the largest segment", () => {
    const all = ["mcp__alpha__one", "mcp__alpha__two", "mcp__beta__x"];
    const text = transcript([
      toolsDelta(o, all),
      instructionsDelta(o, { alpha: "use alpha well" }),
      compactBoundary(later),
      toolsDelta(later, all),
      instructionsDelta(later, { alpha: "use alpha well" }),
      compactBoundary(later),
      toolsDelta(later, ["mcp__alpha__one"]),
    ]);
    const ledger = parseTranscript(text);
    expect(ledger.compactions).toBe(2);
    const alpha = "mcp__alpha__one".length + 1 + "mcp__alpha__two".length + 1 + "use alpha well".length;
    expect(ledger.mcp).toEqual({ alpha: { tools: 2, chars: alpha }, beta: { tools: 1, chars: "mcp__beta__x".length + 1 } });
    expect(ledger.mcpServerMax.alpha).toEqual({ tools: 2, chars: alpha });
  });

  it("ends the block only at a closing tag alone on its line, not one quoted in a snippet", () => {
    const block = [
      "<project-brain: relevant context for this prompt>",
      "- src/a.ts [score 0.80]",
      "  const close = \"</project-brain>\";",
      "  </project-brain>",
      "- src/b.ts [score 0.70]",
      "  two",
      "</project-brain>",
    ].join("\n");
    const line = JSON.stringify({ type: "attachment", sessionId: "s", cwd: "/w", attachment: { type: "hook_success", hookEvent: "UserPromptSubmit", content: `${block}\ntrailing hook text` } });
    const [injection] = parseTranscript(transcript([line])).injections;
    expect(injection!.hits.map((h) => h.source)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(injection!.chars).toBe(block.length);
  });

  it("leaves out injections stamped before the window, with the hits only they brought", () => {
    const text = transcript([
      injection(o, [{ source: "src/old.ts", score: 0.8 }]),
      injection(later, [{ source: "src/new.ts", score: 0.7 }]),
    ]);
    const ledger = parseTranscript(text, Date.parse(later.at));
    expect(ledger.injections).toHaveLength(1);
    expect(ledger.hits.map((h) => h.source)).toEqual(["src/new.ts"]);
  });

  it("skips malformed lines and ignores other hooks' output", () => {
    const other = JSON.stringify({ type: "attachment", attachment: { hookEvent: "SessionStart", content: "<project-brain: relevant context for this prompt>\n- src/a.ts [score 0.9]" } });
    const ledger = parseTranscript(transcript(["{not json", other, userPrompt(o, "hi")]));
    expect(ledger.injections).toEqual([]);
    expect(ledger.sessionId).toBe("s-1");
  });
});

describe("parseTranscriptFile", () => {
  it("streams in small chunks to the same ledger as parsing the whole text, lines spanning chunks included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-ledger-"));
    try {
      const text = transcript([
        toolsDelta(o, ["mcp__alpha__one"]),
        injection(o, [
          { source: "src/a.ts", score: 0.8 },
          { source: "src/b.ts", score: 0.7 },
        ]),
        toolUse(later, "Bash", { command: `cat src/b.ts # ${"x".repeat(300)}` }),
        toolUse(later, "Read", { file_path: "/work/app/src/a.ts" }),
      ]).trimEnd();
      const path = join(dir, "t.jsonl");
      await writeFile(path, text);
      const whole = parseTranscript(text);
      expect(whole.hits.map((h) => h.used)).toEqual([["read"], ["bash"]]);
      for (const chunkBytes of [7, 64, 1024 * 1024]) expect(await parseTranscriptFile(path, { chunkBytes })).toEqual(whole);
      expect(await parseTranscriptFile(join(dir, "missing.jsonl"))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("usageSignal", () => {
  it("reports used precision and recall at each floor that has hits", () => {
    const hit = (score: number, used: boolean) => ({ source: `s${score}`, score, injections: 1, used: used ? (["read"] as const).slice() : [] });
    const signal = usageSignal([hit(0.66, false), hit(0.72, true), hit(0.81, true), hit(0.9, false)]);
    expect(signal.hits).toBe(4);
    expect(signal.used).toBe(2);
    expect(signal.byKind).toEqual({ read: 2 });
    expect(signal.floors.map((r) => r.floor)).toEqual([0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85]);
    expect(signal.floors.find((r) => r.floor === 0.75)).toEqual({ floor: 0.75, hits: 2, used: 1, precision: 0.5, recall: 0.5 });
    expect(usageSignal([hit(0.6, false)]).floors.map((r) => r.floor)).toEqual([0.5, 0.55, 0.6]);
  });
});
