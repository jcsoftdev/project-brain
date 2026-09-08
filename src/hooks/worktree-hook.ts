/**
 * Worktree hooks: keep the brain honest inside a worktree, and reclaim it after.
 *
 * Two subcommands behind one entry point, wired to two events by `setup`:
 *
 *   session  — SessionStart. Reconciles dead worktree indexes, then tells the session
 *              what it is sitting in, but ONLY when that is a linked worktree.
 *   cleanup  — WorktreeRemove. Reconciles and says nothing.
 *
 * Reconciling on both is not belt and braces. `WorktreeRemove` never fires on a
 * non-interactive run, which is exactly the run a delegated agent makes, so the removal
 * event alone leaks an index every time an agent finishes. git is asked either way.
 */

import { worktreeStatus, pruneWorktrees } from "../commands/worktree.js";
import { listLiveWorktrees } from "../git/worktree.js";

/** SessionStart payload wrapper. */
function payload(additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  });
}

/**
 * The SessionStart payload for this working tree, or null when there is nothing to say.
 *
 * Two audiences, two messages. Inside a worktree the session needs FACTS it would
 * otherwise have to shell out for: which index answers for this branch, which port pair
 * is its own. In a main checkout it needs the RULE, because the decision to isolate is
 * made before any worktree exists and a host will not reach for a skill it never thought
 * to look for. The main-checkout text is deliberately short: it is paid every session.
 *
 * Outside a repository there are no worktrees and no rule worth stating, so: null.
 */
export async function buildWorktreeNotice(cwd: string = process.cwd()): Promise<string | null> {
  // listLiveWorktrees returns [] when git fails, which is how "not a repository" is
  // told apart from a main checkout — detectGitContext calls both of them isMain.
  if (listLiveWorktrees(cwd).length === 0) return null;

  const status = await worktreeStatus(cwd);

  if (status.isMain) {
    return payload(
      [
        `Main checkout of \`${status.project}\`.`,
        "",
        "Before delegating work that changes code AND is checked by running the app, " +
          "decide whether it belongs in its own git worktree: use the `brain-worktree` " +
          "skill. An isolated worktree gets its own project-brain index scoped to its " +
          "branch, and its own ports through `port_acquire`, so parallel agents never " +
          "collide on the default port. Read-only work needs none of this.",
      ].join("\n")
    );
  }

  const lines = [
    `You are in the git worktree "${status.worktree}", not the main checkout.`,
    "",
    `- project-brain project id: \`${status.projectId}\``,
    `- mcp-port-registry pair: project="${status.project}" worktree="${status.worktree}"`,
    "",
  ];

  if (status.indexed) {
    lines.push(
      "This worktree has its own index, scoped to its own branch. Pass the project id " +
        "above to project-brain tools, and the pair to `port_acquire` before booting " +
        "anything that listens — a sibling worktree may already hold the default port."
    );
  } else {
    lines.push(
      "This worktree has NO index. Structural tools cannot answer for this branch and " +
        "the MCP server refuses to serve it rather than return empty results. " +
        "Run `project-brain init` here, then `project-brain sync`."
    );
  }

  return payload(lines.join("\n"));
}

/** CLI entry point: `project-brain worktree-hook [session|cleanup]`. */
export async function execute(args: string[] = []): Promise<void> {
  const mode = args.find((a) => !a.startsWith("--")) ?? "session";

  // A hook must never break the thing it is attached to. Every failure here is
  // swallowed: the worst case is an index that survives one session too long, which
  // the next SessionStart reconciles anyway.
  try {
    await pruneWorktrees();
  } catch {
    // reconcile is best-effort
  }

  if (mode !== "session") return;

  try {
    const notice = await buildWorktreeNotice();
    if (notice) console.log(notice);
  } catch {
    // say nothing rather than start a session with an error
  }
}
