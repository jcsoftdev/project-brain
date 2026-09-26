import { join } from "node:path";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { SYNC_LOG_RELATIVE_PATH } from "../commands/sync-status.js";

const HOOK_MARKER = "# project-brain: auto-sync on commit";
// Overwritten (not appended) each run, on purpose: it exists to show what the
// LAST background sync did, not a growing history nobody rotates.
const HOOK_LINE =
  `{ project-brain sync --changed-only && project-brain conceptualize; } > ${SYNC_LOG_RELATIVE_PATH} 2>&1 &`;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces just the command line that follows our marker (an earlier
 * project-brain install, possibly from a previous version — plain sync only,
 * or the sync-and-conceptualize chain redirected to /dev/null) with the
 * current one. `.*` does not span newlines, so this touches exactly that one
 * line and leaves everything else in the hook — including unrelated content
 * from other tools — untouched.
 */
function upgradeHookBlock(content: string): string {
  const pattern = new RegExp(`${escapeRegExp(HOOK_MARKER)}\\n.*`);
  return content.replace(pattern, `${HOOK_MARKER}\n${HOOK_LINE}`);
}

/**
 * Installs (or appends) a post-commit hook that triggers an incremental sync
 * in the background. Idempotent: a hook already carrying our marker is
 * upgraded in place to the current command line rather than duplicated.
 */
export async function installGitHook(repoRoot: string): Promise<void> {
  const hookPath = join(repoRoot, ".git", "hooks", "post-commit");

  let existing = "";
  try {
    existing = await readFile(hookPath, "utf-8");
  } catch {
    // No existing hook — we'll create one from scratch.
  }

  if (existing.includes(HOOK_MARKER)) {
    const upgraded = upgradeHookBlock(existing);
    if (upgraded === existing) return; // already current — nothing to do
    await writeFile(hookPath, upgraded);
    await chmod(hookPath, 0o755);
    return;
  }

  const block = `${HOOK_MARKER}\n${HOOK_LINE}\n`;
  const content = existing
    ? `${existing.replace(/\n*$/, "\n")}\n${block}`
    : `#!/bin/sh\n${block}`;

  await writeFile(hookPath, content);
  await chmod(hookPath, 0o755);
}
