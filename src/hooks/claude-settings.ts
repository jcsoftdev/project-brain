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
