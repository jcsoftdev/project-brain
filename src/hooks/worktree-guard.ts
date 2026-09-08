/**
 * PreToolUse guard: refuse a sub-agent spawn that never decided about isolation.
 *
 * Built on the same verified mechanism as `routing-guard`: PreToolUse DOES fire on the
 * spawn tool, its payload carries `tool_input.description` and `tool_input.prompt`, and
 * exit code 2 is the block channel — it hands stderr to the model as the reason, which
 * is the retry prompt we want. The event supports neither `additionalContext` nor
 * `updatedInput`, so blocking with a reason is the ONLY way this hook can teach anything.
 *
 * No keyword heuristic, on purpose. A classifier that guesses "this delegation will run
 * the app" is wrong in both directions: it misses the delegation phrased without its
 * vocabulary, and it fires on one that merely said "port". This asks for an
 * ACKNOWLEDGEMENT instead — say the word `worktree`, either way — which cannot be
 * guessed wrong because the model is stating its own intent rather than having it
 * inferred. The cost is one extra turn on the first delegation that forgot.
 */

import { detectGitContext, listLiveWorktrees } from "../git/worktree.js";

const SPAWN_TOOLS = new Set(["Task", "Agent"]);

/** The single token that proves isolation was considered, in either direction. */
const ACKNOWLEDGEMENT = "worktree";

export interface GuardContext {
  /** False once the session is already inside a linked worktree. */
  isMain: boolean;
  /** False outside any git repository, where worktrees cannot exist. */
  inRepo: boolean;
}

export interface GuardDecision {
  block: boolean;
  reason?: string;
}

const ALLOW: GuardDecision = { block: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Concatenate the free-text fields a spawn carries, lowercased. */
function spokenText(input: Record<string, unknown>): string {
  return ["description", "prompt"]
    .map((key) => (typeof input[key] === "string" ? (input[key] as string) : ""))
    .join(" ")
    .toLowerCase();
}

/**
 * Decide whether to block, from a PreToolUse payload and the session's git context.
 *
 * Fails OPEN on anything unexpected, and never fires from inside a worktree or outside
 * a repository — in both of those the question has no answer left to give.
 */
export function worktreeGuardDecision(payload: unknown, context: GuardContext): GuardDecision {
  if (!context.inRepo || !context.isMain) return ALLOW;
  if (!isPlainObject(payload)) return ALLOW;

  const toolName = payload.tool_name;
  if (typeof toolName !== "string" || !SPAWN_TOOLS.has(toolName)) return ALLOW;

  const input = payload.tool_input;
  if (!isPlainObject(input)) return ALLOW;

  if (spokenText(input).includes(ACKNOWLEDGEMENT)) return ALLOW;

  return {
    block: true,
    reason:
      "This delegation is being launched from the main checkout and says nothing about " +
      "isolation. Decide before you spawn: work that changes code AND is checked by " +
      "running the app belongs in its own git worktree, which gets its own " +
      "project-brain index scoped to its branch and its own ports through " +
      "`port_acquire` — without that, parallel agents answer from the wrong branch's " +
      "graph and collide on the default port. The `brain-worktree` skill has the " +
      "sequence. Re-issue the delegation with the word `worktree` in its description, " +
      "either naming the worktree it runs in or saying plainly that this task does not " +
      "need one.",
  };
}

/** Read the session's git context. Fails open: an unknown context guards nothing. */
export function readGuardContext(cwd: string = process.cwd()): GuardContext {
  try {
    if (listLiveWorktrees(cwd).length === 0) return { isMain: true, inRepo: false };
    return { isMain: detectGitContext(cwd).isMain, inRepo: true };
  } catch {
    return { isMain: true, inRepo: false };
  }
}

/** CLI entry point: read the hook payload on stdin, exit 2 to block. */
export async function execute(): Promise<void> {
  let payload: unknown = null;
  try {
    payload = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0); // unreadable stdin — allow, per fail-open
  }

  const decision = worktreeGuardDecision(payload, readGuardContext());
  if (!decision.block) process.exit(0);

  process.stderr.write(`${decision.reason}\n`);
  process.exit(2);
}
