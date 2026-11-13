import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { LlmUnavailableError } from "../../src/llm/client.js";
import {
  claudeCodeArgv,
  createClaudeCodeClient,
  type CommandRunner,
  type RunRequest,
  type RunResult,
} from "../../src/llm/claude-code-client.js";

function fakeRunner(result: Partial<RunResult>) {
  const calls: { argv: string[]; req: RunRequest }[] = [];
  const run: CommandRunner = async (argv, req) => {
    calls.push({ argv, req });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
  return { calls, run };
}

const which = () => "/usr/local/bin/claude";
const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe("createClaudeCodeClient", () => {
  it("runs claude -p isolated from the owner's hooks, plugins and MCP, with the prompt on stdin", async () => {
    const { calls, run } = fakeRunner({ stdout: "## Purpose\n\nx\n" });
    const prompt = "Diff for this module in this commit:\n+secret change";
    const llm = createClaudeCodeClient({
      model: "haiku",
      run,
      which,
      env: { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc", CLAUDE_CONFIG_DIR: "/cfg" },
    });

    expect(await llm.complete(prompt)).toBe("## Purpose\n\nx");
    const { argv, req } = calls[0];
    expect(argv[0]).toBe("/usr/local/bin/claude");
    expect(argv).toContain("-p");
    expect(flagValue(argv, "--model")).toBe("haiku");
    expect(flagValue(argv, "--output-format")).toBe("text");
    for (const flag of ["--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) {
      expect(argv).toContain(flag);
    }
    expect(flagValue(argv, "--setting-sources")).toBe("");
    expect(flagValue(argv, "--tools")).toBe("");
    expect(JSON.parse(flagValue(argv, "--settings"))).toEqual({ disableAllHooks: true });
    expect(argv).not.toContain("--bare");

    expect(req.stdin).toBe(prompt);
    expect(argv.some((a) => a.includes("secret change"))).toBe(false);
    expect(req.cwd).toBe(tmpdir());
    expect(req.env).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/cfg", BRAIN_CONCEPT_CHILD: "1" });
  });

  it("is unavailable without claude on PATH, and never spawns", async () => {
    const { calls, run } = fakeRunner({});
    const llm = createClaudeCodeClient({ model: "haiku", run, which: () => null });
    await expect(llm.complete("p")).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it("is unavailable when logged out or out of quota", async () => {
    for (const stdout of ["Not logged in · Please run /login", "Claude usage limit reached. Your limit will reset at 5pm"]) {
      const { run } = fakeRunner({ exitCode: 1, stdout });
      await expect(createClaudeCodeClient({ model: "haiku", run, which }).complete("p")).rejects.toBeInstanceOf(LlmUnavailableError);
    }
  });

  it("fails plainly on a timeout or another error, so the module is retried", async () => {
    const timed = fakeRunner({ timedOut: true, exitCode: 143 });
    const run = createClaudeCodeClient({ model: "haiku", run: timed.run, which, timeoutMs: 5000 }).complete("p");
    await expect(run).rejects.toThrow("timed out after 5s");
    await expect(run).rejects.not.toBeInstanceOf(LlmUnavailableError);
    expect(timed.calls[0].req.timeoutMs).toBe(5000);

    const broken = fakeRunner({ exitCode: 2, stderr: "API Error: 529 overloaded" });
    const other = createClaudeCodeClient({ model: "haiku", run: broken.run, which }).complete("p");
    await expect(other).rejects.toThrow("exited 2");
    await expect(other).rejects.not.toBeInstanceOf(LlmUnavailableError);
  });

  it("puts the model where claude expects it", () => {
    expect(flagValue(claudeCodeArgv("sonnet"), "--model")).toBe("sonnet");
  });
});
