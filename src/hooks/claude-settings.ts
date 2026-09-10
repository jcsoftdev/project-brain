/**
 * Manages the Claude Code settings.json hooks project-brain installs.
 *
 * Two independent concerns live here:
 *   - the PROJECT-level context hook (`init`): UserPromptSubmit runs
 *     `project-brain search --stdin` so project context is injected per prompt.
 *   - the GLOBAL routing hooks (`setup`): SessionStart injects the routing
 *     rules once per session, and — only when asked — PreToolUse blocks a
 *     sub-agent spawn that names no model.
 */

const HOOK_COMMAND = "project-brain search --stdin";

const HOOK_COMMAND_ENTRY = {
  type: "command",
  command: HOOK_COMMAND,
  // Measured baseline is ~4-4.1s per invocation (the internal 4000ms
  // safety race in commands/search.ts execute() + process exit overhead)
  // even with a warm Ollama — 8s left too little margin under real-world
  // hook-spawn overhead and concurrent-invocation contention.
  timeout: 15,
  statusMessage: "project-brain: injecting context",
} as const;

// Claude Code schema: each UserPromptSubmit array item is a matcher group with
// a REQUIRED `hooks` array of command entries — NOT a bare command entry.
const HOOK_GROUP = { hooks: [HOOK_COMMAND_ENTRY] } as const;

/** True if a matcher group contains a project-brain search command entry. */
function groupHasContextHook(group: Record<string, unknown>): boolean {
  const inner = Array.isArray(group.hooks) ? (group.hooks as Array<Record<string, unknown>>) : [];
  return inner.some(
    (h) => typeof h.command === "string" && h.command.includes("project-brain search")
  );
}

/**
 * Pure function: takes existing parsed settings (or null for fresh) and
 * returns a new settings object with the UserPromptSubmit hook ensured.
 *
 * Idempotent: if any UserPromptSubmit group already contains a command hook
 * referencing "project-brain search", it is not duplicated.
 *
 * All other keys (permissions, hooks for other events, etc.) are preserved.
 */
export function upsertContextHook(existing: object | null): object {
  const base: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  // Deep-clone hooks to avoid mutating the input
  const existingHooks = (base.hooks as Record<string, unknown> | undefined) ?? {};
  const hooks: Record<string, unknown> = { ...existingHooks };

  // Get current UserPromptSubmit matcher groups (ensure it's an array)
  const current: Array<Record<string, unknown>> = Array.isArray(hooks.UserPromptSubmit)
    ? (hooks.UserPromptSubmit as Array<Record<string, unknown>>)
    : [];

  // Idempotency check: skip if any group already has the context hook
  const alreadyInstalled = current.some(groupHasContextHook);

  hooks.UserPromptSubmit = alreadyInstalled ? current : [...current, HOOK_GROUP];

  return { ...base, hooks };
}

const ROUTING_REMINDER_COMMAND = "project-brain routing-rules";
const ROUTING_GUARD_COMMAND = "project-brain routing-guard";

/**
 * Tool names that spawn a sub-agent.
 *
 * Both spellings on purpose: the tool is `Task` in older builds and `Agent` in
 * current ones, and a matcher that only knows one silently never fires on the
 * other — the worst failure mode a guard can have.
 */
const SPAWN_TOOL_MATCHER = "Task|Agent";

/** True if a matcher group contains a command entry mentioning `needle`. */
function groupHasCommand(group: Record<string, unknown>, needle: string): boolean {
  const inner = Array.isArray(group.hooks) ? (group.hooks as Array<Record<string, unknown>>) : [];
  return inner.some((h) => typeof h.command === "string" && h.command.includes(needle));
}

function addGroup(
  hooks: Record<string, unknown>,
  event: string,
  needle: string,
  group: object
): void {
  const current: Array<Record<string, unknown>> = Array.isArray(hooks[event])
    ? (hooks[event] as Array<Record<string, unknown>>)
    : [];

  hooks[event] = current.some((g) => groupHasCommand(g, needle)) ? current : [...current, group];
}

/**
 * Drop every matcher group for `event` whose command list mentions one of
 * `needles`, and delete the event key entirely when nothing is left.
 *
 * A group is removed whole rather than filtered entry by entry because
 * `addGroup` only ever adds groups it built itself, one command each — so a
 * group carrying one of our commands has nothing of the user's in it. A group
 * we did not write survives untouched, which is what keeps another tool's
 * SessionStart hook alive next to ours.
 */
function dropGroups(hooks: Record<string, unknown>, event: string, needles: string[]): void {
  const current: Array<Record<string, unknown>> = Array.isArray(hooks[event])
    ? (hooks[event] as Array<Record<string, unknown>>)
    : [];

  const kept = current.filter((g) => !needles.some((n) => groupHasCommand(g, n)));
  if (kept.length === 0) delete hooks[event];
  else hooks[event] = kept;
}

/**
 * Ensure the model-routing hooks exist in a parsed settings object.
 *
 * SessionStart carries the reminder because it is one of the few events that
 * accept `additionalContext`, and it fires once per session rather than once
 * per prompt. PreToolUse carries enforcement, and only when `strict` — it
 * blocks a real tool call, and inheriting the session model is a legitimate
 * choice, so it is never the default.
 *
 * Idempotent and non-mutating: all other keys and every other event's hooks
 * survive untouched, and running it twice adds nothing.
 */
export function upsertRoutingHooks(
  existing: object | null,
  options: { strict: boolean }
): object {
  const base: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const hooks: Record<string, unknown> = { ...((base.hooks as Record<string, unknown>) ?? {}) };

  addGroup(hooks, "SessionStart", ROUTING_REMINDER_COMMAND, {
    hooks: [
      {
        type: "command",
        command: ROUTING_REMINDER_COMMAND,
        timeout: 5,
        statusMessage: "project-brain: model-routing rules",
      },
    ],
  });

  if (options.strict) {
    addGroup(hooks, "PreToolUse", ROUTING_GUARD_COMMAND, {
      matcher: SPAWN_TOOL_MATCHER,
      hooks: [
        {
          type: "command",
          command: ROUTING_GUARD_COMMAND,
          timeout: 5,
          statusMessage: "project-brain: checking delegation tier",
        },
      ],
    });
  }

  return { ...base, hooks };
}

const WORKTREE_SESSION_COMMAND = "project-brain worktree-hook session";
const WORKTREE_CLEANUP_COMMAND = "project-brain worktree-hook cleanup";
const WORKTREE_GUARD_COMMAND = "project-brain worktree-guard";
const SESSION_TITLE_NOTICE_COMMAND = "project-brain session-title notice";
const SESSION_TITLE_APPLY_COMMAND = "project-brain session-title apply";

/**
 * Ensure the worktree hooks exist in a parsed settings object.
 *
 * Two events, because one of them is not enough. `WorktreeRemove` is the honest signal
 * and fires the moment a worktree goes, but Claude Code skips hooks entirely on
 * non-interactive runs — exactly the runs a delegated agent makes. So `SessionStart`
 * reconciles as well: it asks git which worktrees are still live and reclaims whatever
 * the removal event never reported. The same reason mcp-port-registry reconciles its
 * leases instead of trusting release alone.
 *
 * `strict` adds a PreToolUse guard that blocks a sub-agent spawn from the main checkout
 * until its description says whether the task needs a worktree. Opt-in for
 * {@link upsertRoutingHooks}' reason: it blocks a real tool call, and one extra turn on
 * every delegation is a cost only its owner can agree to.
 *
 * Idempotent and non-mutating, like {@link upsertRoutingHooks}.
 */
export function upsertWorktreeHooks(
  existing: object | null,
  options: { strict: boolean } = { strict: false }
): object {
  const base: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const hooks: Record<string, unknown> = { ...((base.hooks as Record<string, unknown>) ?? {}) };

  addGroup(hooks, "SessionStart", WORKTREE_SESSION_COMMAND, {
    hooks: [
      {
        type: "command",
        command: WORKTREE_SESSION_COMMAND,
        timeout: 10,
        statusMessage: "project-brain: worktree identity",
      },
    ],
  });

  addGroup(hooks, "WorktreeRemove", WORKTREE_CLEANUP_COMMAND, {
    hooks: [
      {
        type: "command",
        command: WORKTREE_CLEANUP_COMMAND,
        timeout: 15,
        statusMessage: "project-brain: reclaim worktree index",
      },
    ],
  });

  if (options.strict) {
    addGroup(hooks, "PreToolUse", WORKTREE_GUARD_COMMAND, {
      matcher: SPAWN_TOOL_MATCHER,
      hooks: [
        {
          type: "command",
          command: WORKTREE_GUARD_COMMAND,
          timeout: 10,
        },
      ],
    });
  }

  return { ...base, hooks };
}

/**
 * Remove the model-routing hooks from a parsed settings object.
 *
 * The inverse of {@link upsertRoutingHooks}, and deliberately narrow: it names
 * only the two routing commands, so the worktree hooks and the project-level
 * context hook survive even though all three share `SessionStart`.
 *
 * Pure, non-mutating and idempotent, like its counterpart.
 */
export function removeRoutingHooks(existing: object | null): object {
  const base: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const hooks: Record<string, unknown> = { ...((base.hooks as Record<string, unknown>) ?? {}) };

  dropGroups(hooks, "SessionStart", [ROUTING_REMINDER_COMMAND]);
  dropGroups(hooks, "PreToolUse", [ROUTING_GUARD_COMMAND]);

  return { ...base, hooks };
}

/**
 * Add the session-title hook to a parsed settings object.
 *
 * `Stop` rather than `SessionStart`, because a session has no subject worth naming until
 * it has run for a while, and the name has to keep up when the subject moves. The hook
 * itself is silent whenever the agent has not written a name, so the cost of firing on
 * every turn is one file that is usually absent.
 *
 * Pure, non-mutating and idempotent, like its siblings.
 */
export function upsertSessionTitleHook(existing: object | null): object {
  const base: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const hooks: Record<string, unknown> = { ...((base.hooks as Record<string, unknown>) ?? {}) };

  addGroup(hooks, "SessionStart", SESSION_TITLE_NOTICE_COMMAND, {
    hooks: [
      {
        type: "command",
        command: SESSION_TITLE_NOTICE_COMMAND,
        timeout: 5,
        statusMessage: "project-brain: session naming rule",
      },
    ],
  });

  addGroup(hooks, "Stop", SESSION_TITLE_APPLY_COMMAND, {
    hooks: [
      {
        type: "command",
        command: SESSION_TITLE_APPLY_COMMAND,
        timeout: 5,
        statusMessage: "project-brain: session title",
      },
    ],
  });

  return { ...base, hooks };
}

/**
 * Remove the session-title hook from a parsed settings object.
 *
 * The inverse of {@link upsertSessionTitleHook}, narrow for
 * {@link removeRoutingHooks}' reason.
 */
export function removeSessionTitleHook(existing: object | null): object {
  const base: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const hooks: Record<string, unknown> = { ...((base.hooks as Record<string, unknown>) ?? {}) };

  dropGroups(hooks, "SessionStart", [SESSION_TITLE_NOTICE_COMMAND]);
  dropGroups(hooks, "Stop", [SESSION_TITLE_APPLY_COMMAND]);

  return { ...base, hooks };
}

/**
 * Remove the worktree hooks from a parsed settings object.
 *
 * The inverse of {@link upsertWorktreeHooks}, narrow for
 * {@link removeRoutingHooks}' reason.
 */
export function removeWorktreeHooks(existing: object | null): object {
  const base: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const hooks: Record<string, unknown> = { ...((base.hooks as Record<string, unknown>) ?? {}) };

  dropGroups(hooks, "SessionStart", [WORKTREE_SESSION_COMMAND]);
  dropGroups(hooks, "WorktreeRemove", [WORKTREE_CLEANUP_COMMAND]);
  dropGroups(hooks, "PreToolUse", [WORKTREE_GUARD_COMMAND]);

  return { ...base, hooks };
}
