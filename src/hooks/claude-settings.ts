/**
 * Manages the project-level .claude/settings.json hook for context injection.
 *
 * The UserPromptSubmit hook runs `project-brain search --stdin` on every
 * Claude prompt so the project-brain context is automatically injected.
 */

const HOOK_COMMAND = "project-brain search --stdin";

const HOOK_COMMAND_ENTRY = {
  type: "command",
  command: HOOK_COMMAND,
  timeout: 8,
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
