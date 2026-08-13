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
 * Ask whether to write the model-routing section into every detected host's
 * rules file.
 *
 * Opt-OUT, like promptSkillInstall: a non-interactive run resolves TRUE, so
 * scripted and CI installs get the guidance. It is part of what setup
 * delivers, not a bonus — `--no-model-routing` is the way out.
 *
 * Only prompts in a real interactive TTY session (both stdio streams attached,
 * not CI), so scripted runs never hang waiting on input. Cancelling means no:
 * an interrupted user did not consent to a home-directory write.
 */
export async function promptModelRouting(): Promise<boolean> {
  const interactive =
    Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY) && !process.env.CI;
  if (!interactive) return true;

  const clack = await import("@clack/prompts");
  const answer = await clack.confirm({
    message:
      "Add model-routing guidance for delegated agents to your AI tools' rules files? " +
      "(which tier — fast/balanced/deep — to use per task type, and how to set it on each host)",
    initialValue: true,
  });
  if (clack.isCancel(answer)) return false;
  return answer;
}
