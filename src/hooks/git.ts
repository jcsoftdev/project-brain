import { join } from "node:path";
import { chmod, readFile, writeFile } from "node:fs/promises";

const HOOK_MARKER = "# project-brain: auto-sync on commit";
const HOOK_LINE = "project-brain sync --changed-only && project-brain conceptualize > /dev/null 2>&1 &";

/**
 * Installs (or appends) a post-commit hook that triggers an incremental sync
 * in the background. Idempotent: skips if project-brain is already wired in.
 */
export async function installGitHook(repoRoot: string): Promise<void> {
  const hookPath = join(repoRoot, ".git", "hooks", "post-commit");

  let existing = "";
  try {
    existing = await readFile(hookPath, "utf-8");
  } catch {
    // No existing hook — we'll create one from scratch.
  }

  // Idempotent: don't duplicate if already present.
  if (existing.includes("project-brain sync")) {
    return;
  }

  const block = `${HOOK_MARKER}\n${HOOK_LINE}\n`;
  const content = existing
    ? `${existing.replace(/\n*$/, "\n")}\n${block}`
    : `#!/bin/sh\n${block}`;

  await writeFile(hookPath, content);
  await chmod(hookPath, 0o755);
}
