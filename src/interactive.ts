/**
 * Interactive CLI prompts, isolated from setup.ts so the @clack/prompts import
 * only happens lazily and only when the TTY guard actually needs it.
 */

/** True only in a real interactive session — both stdio streams attached, not CI. */
function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY) && !process.env.CI;
}

/**
 * Ask whether to install the brain-audit skill into each registered tool's
 * global skills directory.
 *
 * Non-interactive resolves TRUE — the opposite of `promptModelRouting`. The
 * skill is part of what `setup` delivers, so a scripted or CI install gets it;
 * `--no-brain-audit` is the only way to opt out. Cancelling the prompt means
 * no, since an interrupted user did not consent to a home-directory write.
 */
export async function promptSkillInstall(): Promise<boolean> {
  if (!isInteractive()) return true;

  const clack = await import("@clack/prompts");
  const answer = await clack.confirm({
    message:
      "Install the brain-audit skill into your AI tools' global skills directory? (whole-project audit: dead code, orphan UI, broken flows, security and architecture findings)",
    initialValue: true,
  });
  if (clack.isCancel(answer)) return false;
  return answer;
}

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
