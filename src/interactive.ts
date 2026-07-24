/**
 * Interactive CLI prompts, isolated from setup.ts so the @clack/prompts import
 * only happens lazily and only when the TTY guard actually needs it.
 */

/**
 * Ask whether to write the opt-in model-routing section to CLAUDE.md.
 * Only prompts in a real interactive TTY session (both stdio streams attached,
 * not CI) — otherwise resolves false without touching stdin, so scripted/CI
 * runs never hang waiting on input.
 */
export async function promptModelRouting(): Promise<boolean> {
  const interactive =
    Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY) && !process.env.CI;
  if (!interactive) return false;

  const clack = await import("@clack/prompts");
  const answer = await clack.confirm({
    message:
      "Add model-routing guidance for delegated agents to CLAUDE.md? (tells Claude Code which model — haiku/sonnet/opus — to use per task type)",
    initialValue: false,
  });
  if (clack.isCancel(answer)) return false;
  return answer;
}
