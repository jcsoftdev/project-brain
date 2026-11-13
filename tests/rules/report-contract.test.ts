import { describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { ROUTING_CONTENT_VERSION } from "../../src/constants.js";
import { writeRoutingSection } from "../../src/registrars/routing-section.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPORT_CONTRACT,
  REPORT_CONTRACT_HEADING,
  asksForStructuredOutput,
  withReportContract,
} from "../../src/rules/report-contract.js";
import { reportContractOutput } from "../../src/hooks/report-contract.js";
import { getModelRoutingSection } from "../../src/rules/model-routing.js";
import { buildRoutingReminder } from "../../src/hooks/routing-rules.js";
import { ClaudeRegistrar } from "../../src/registrars/claude.js";
import { CodexRegistrar } from "../../src/registrars/codex.js";

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("report contract text", () => {
  it("names every field the hand-back must carry", () => {
    for (const field of ["Verdict: PASS, BLOCKERS, PARTIAL or DONE", "Changes:", "Tests:", "Risks", "Needs a decision", "~400 words", "job tmp or the worktree"]) {
      expect(REPORT_CONTRACT).toContain(field);
    }
  });

  it("is rendered into the routing skill for every host", async () => {
    for (const registrar of [new ClaudeRegistrar(), new CodexRegistrar()]) {
      const section = await getModelRoutingSection(registrar);
      expect(section).toContain(REPORT_CONTRACT);
      expect(section).not.toContain("{{reportContract}}");
    }
  });

  it("is named in the SessionStart reminder, both full and pointer form", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-contract-"));
    try {
      const rulesPath = join(dir, "CLAUDE.md");
      const full = JSON.parse(await buildRoutingReminder(join(dir, "none.json"), rulesPath));
      expect(full.hookSpecificOutput.additionalContext).toContain("report contract");

      await writeRoutingSection(rulesPath, `<!-- model-routing-version: ${ROUTING_CONTENT_VERSION} -->\nload the \`brain-model-routing\` skill\n`);
      const pointer = JSON.parse(await buildRoutingReminder(join(dir, "none.json"), rulesPath));
      expect(pointer.hookSpecificOutput.additionalContext).toContain("report contract");
      expect(pointer.hookSpecificOutput.additionalContext.length).toBeLessThan(600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("withReportContract", () => {
  it("appends the contract once, however many times it runs", () => {
    const once = withReportContract("Find where auth tokens are refreshed.");
    expect(occurrences(once, REPORT_CONTRACT_HEADING)).toBe(1);
    expect(withReportContract(once)).toBe(once);
    expect(once.startsWith("Find where auth tokens are refreshed.")).toBe(true);
  });

  it.each([
    "Return a JSON array of { path, line } objects.",
    "Respond only with JSON matching this schema.",
    "Output as YAML.",
    "```json\n{ \"verdict\": \"\" }\n```",
    "Use structured output.",
    "Report in at most 300 words: the verdict and the risks.",
    "Do the work.\n\n## Output format\n- one line per finding",
  ])("leaves a prompt that sets its own output shape untouched: %s", (prompt) => {
    expect(asksForStructuredOutput(prompt)).toBe(true);
    expect(withReportContract(prompt)).toBe(prompt);
  });

  it("does not mistake a mention of JSON in the task for an output format", () => {
    expect(asksForStructuredOutput("Fix the bug in the JSON parser and add a test.")).toBe(false);
  });
});

describe("report-contract PreToolUse hook", () => {
  const payload = (tool: string, prompt: unknown) => ({
    tool_name: tool,
    tool_input: { description: "haiku: locate auth", prompt, model: "haiku", subagent_type: "Explore" },
  });

  it("rewrites the prompt and keeps every other input field, with no permission decision", () => {
    const out = reportContractOutput(payload("Agent", "Locate the auth handler.")) as any;
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    const input = out.hookSpecificOutput.updatedInput;
    expect(input).toMatchObject({ description: "haiku: locate auth", model: "haiku", subagent_type: "Explore" });
    expect(input.prompt).toContain(REPORT_CONTRACT_HEADING);
  });

  it("stays silent when the prompt already carries the contract or a structured format", () => {
    expect(reportContractOutput(payload("Task", withReportContract("Locate it.")))).toBeNull();
    expect(reportContractOutput(payload("Agent", "Return JSON only."))).toBeNull();
  });

  it("fails open on other tools and malformed input", () => {
    expect(reportContractOutput(payload("Bash", "ls"))).toBeNull();
    expect(reportContractOutput(payload("Agent", 42))).toBeNull();
    expect(reportContractOutput(null)).toBeNull();
    expect(reportContractOutput({ tool_name: "Agent" })).toBeNull();
  });
});
