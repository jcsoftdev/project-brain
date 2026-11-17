import { describe, expect, it } from "bun:test";
import { reportContractOutput } from "../../src/hooks/report-contract.js";

describe("browser limits in a delegation", () => {
  const call = (prompt: string) => ({ tool_name: "Agent", tool_input: { description: "x", prompt } });

  it("adds the limits when the prompt is about a browser, after the report contract", () => {
    const out = reportContractOutput(call("Walk the app in the browser and check the cashier flow.")) as any;
    const prompt: string = out.hookSpecificOutput.updatedInput.prompt;
    expect(prompt).toContain("## Browser limits");
    expect(prompt).toContain("`<agent>-<role>`");
    expect(prompt).toContain("At most 4 pages");
    expect(prompt).toContain("Close every page");
    expect(prompt).toContain("claude-in-chrome");
    expect(prompt).toContain("## Report contract");
  });

  it("leaves a prompt that is not about a browser without them", () => {
    const out = reportContractOutput(call("Refactor the parser module.")) as any;
    expect(out.hookSpecificOutput.updatedInput.prompt).not.toContain("## Browser limits");
  });

  it("adds them once", () => {
    const first = (reportContractOutput(call("Open Chrome and look at the page.")) as any).hookSpecificOutput.updatedInput.prompt;
    expect(reportContractOutput(call(first))).toBeNull();
    expect(first.match(/## Browser limits/g)).toHaveLength(1);
  });
});
