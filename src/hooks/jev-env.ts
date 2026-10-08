/**
 * SessionStart hook: hand the stored TypeSafe token to the session's shell.
 *
 * Tools outside project-brain (the typesafe-ai skill, the TypeSafe SDK, ad-hoc
 * scripts) only read `TYPESAFE_API_KEY`, while the token `setup` stores lives in
 * `reranker.json`. Claude Code exposes `CLAUDE_ENV_FILE` to SessionStart hooks;
 * `export` lines appended there persist into every later Bash command.
 *
 * The line is appended, never written over, because other hooks share that file.
 * Nothing here may print: hook output lands in the transcript, and the token must
 * not.
 */

import { appendFile, readFile } from "node:fs/promises";
import { resolveRerankerToken } from "../rerank/token.js";

export interface JevEnvContext {
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string | null>;
  appendFile: (path: string, data: string) => Promise<void>;
  resolveToken: () => Promise<string | null>;
}

const EXPORT_PREFIX = "export TYPESAFE_API_KEY=";

/** POSIX single-quote escaping: a quote closes the string, is escaped, and reopens it. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Append the export to `CLAUDE_ENV_FILE` when it is wanted. Returns whether it wrote.
 *
 * An existing process value wins and is left alone: the user set it on purpose, and
 * the file may hold a different token than the one they are using right now.
 */
export async function exportJevEnv(ctx: JevEnvContext): Promise<boolean> {
  const envFile = ctx.env.CLAUDE_ENV_FILE;
  if (!envFile || ctx.env.TYPESAFE_API_KEY) return false;

  const token = await ctx.resolveToken();
  if (!token) return false;

  const current = (await ctx.readFile(envFile)) ?? "";
  if (current.split("\n").some((line) => line.trimStart().startsWith(EXPORT_PREFIX))) return false;

  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await ctx.appendFile(envFile, `${separator}${EXPORT_PREFIX}${shellQuote(token)}\n`);
  return true;
}

export async function execute(): Promise<void> {
  try {
    await exportJevEnv({
      env: process.env,
      readFile: (path) => readFile(path, "utf8").catch(() => null),
      appendFile: (path, data) => appendFile(path, data),
      resolveToken: () => resolveRerankerToken(),
    });
  } catch {
    // A failing hook would only add noise to a session start.
  }
}
