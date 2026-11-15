import { tmpdir } from "node:os";
import { LlmUnavailableError, type LlmClient } from "./client.js";

export const CLAUDE_CODE_CONCEPT_TIMEOUT_MS = 120_000;

/** Set on the child so a project-brain command it could reach knows it runs inside conceptualize. */
export const CONCEPT_CHILD_ENV = "BRAIN_CONCEPT_CHILD";

const SYSTEM_PROMPT =
  "You maintain concise markdown summaries of a codebase's modules. Reply with the requested markdown only.";

/**
 * `claude -p` as a bare text completion that never becomes a session of the owner's.
 *
 * - `--safe-mode` skips CLAUDE.md, skills, plugins, hooks, MCP servers and output
 *   styles while keeping the normal login. `--bare` would skip them too, but it
 *   reads only ANTHROPIC_API_KEY, and the whole point here is the subscription.
 * - `--setting-sources ""`, `disableAllHooks` and `--strict-mcp-config` repeat that
 *   for settings files, hooks and MCP in case safe mode ever narrows. A hook that
 *   ran here would be project-brain's own SessionStart and UserPromptSubmit,
 *   spending tokens to search the brain for a docs rewrite.
 * - `--tools ""` leaves nothing to act with, and `--no-session-persistence` keeps
 *   the run out of `/resume`.
 *
 * The prompt goes on stdin: a diff in argv would show in `ps` and can exceed ARG_MAX.
 */
export function claudeCodeArgv(model: string): string[] {
  return [
    "claude",
    "-p",
    "--model",
    model,
    "--output-format",
    "text",
    "--safe-mode",
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--strict-mcp-config",
    "--tools",
    "",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--system-prompt",
    SYSTEM_PROMPT,
  ];
}

/**
 * The parent session's identity. Inherited by a hook that fires from a commit an
 * agent made, they would tie the child to that session — its messaging socket,
 * its id, its "nested" marker.
 */
const PARENT_SESSION_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_PID",
  "CLAUDE_JOB_DIR",
  // With any of these, claude bills an API key or another endpoint instead of the
  // subscription login, which is not what the claude-code backend discloses.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
];

export function claudeCodeEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !PARENT_SESSION_ENV.includes(key)) out[key] = value;
  }
  out[CONCEPT_CHILD_ENV] = "1";
  return out;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunRequest {
  stdin: string;
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
}

export type CommandRunner = (argv: string[], req: RunRequest) => Promise<RunResult>;

/**
 * Detached, so the child leads its own process group and a timeout kills the
 * whole group: a grandchild left holding stdout would otherwise keep the read
 * below open after `claude` itself is gone.
 */
export const spawnRunner: CommandRunner = async (argv, req) => {
  // A Blob lets Bun feed stdin itself: a child that exits before reading (logged out)
  // then cannot surface EPIPE as an unhandled rejection from a pending FileSink flush,
  // which is what happens on Linux with a manual write.
  const proc = Bun.spawn(argv, {
    stdin: new Blob([req.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: req.env,
    cwd: req.cwd,
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }, req.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

/** Failures no retry fixes: logged out, or out of quota. */
const UNAVAILABLE = /not logged in|\/login|authenticat|invalid api key|usage limit|limit reached|credit balance/i;

export interface ClaudeCodeClientOptions {
  model: string;
  timeoutMs?: number;
  run?: CommandRunner;
  which?: (bin: string) => string | null;
  env?: Record<string, string | undefined>;
}

export function createClaudeCodeClient(opts: ClaudeCodeClientOptions): LlmClient {
  const run = opts.run ?? spawnRunner;
  const which = opts.which ?? ((bin: string) => Bun.which(bin));
  const timeoutMs = opts.timeoutMs ?? CLAUDE_CODE_CONCEPT_TIMEOUT_MS;

  return {
    async complete(prompt: string): Promise<string> {
      const bin = which("claude");
      if (!bin) throw new LlmUnavailableError("`claude` is not on PATH");
      const [, ...rest] = claudeCodeArgv(opts.model);
      const result = await run([bin, ...rest], {
        stdin: prompt,
        env: claudeCodeEnv(opts.env),
        // Outside any repository, so no project settings or CLAUDE.md sit in reach.
        cwd: tmpdir(),
        timeoutMs,
      });
      // The next module would take as long: give up the run rather than retry.
      if (result.timedOut) throw new LlmUnavailableError(`claude -p timed out after ${Math.round(timeoutMs / 1000)}s`);
      if (result.exitCode !== 0) {
        const reason = (result.stderr.trim() || result.stdout.trim()).split("\n")[0] ?? "";
        if (UNAVAILABLE.test(reason)) throw new LlmUnavailableError(`claude -p: ${reason}`);
        throw new Error(`claude -p exited ${result.exitCode}: ${reason}`);
      }
      const text = result.stdout.trim();
      if (!text) throw new Error("claude -p returned no text");
      return text;
    },
  };
}
