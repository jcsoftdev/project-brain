/**
 * Manages the project-level .claude/settings.json hook for context injection.
 *
 * The UserPromptSubmit hook runs `project-brain search --stdin` on every
 * Claude prompt so the project-brain context is automatically injected.
 */

const HOOK_COMMAND = "project-brain search --stdin";

const HOOK_ENTRY = {
  type: "command",
  command: HOOK_COMMAND,
  timeout: 8,
  statusMessage: "project-brain: injecting context",
} as const;

/**
 * Pure function: takes existing parsed settings (or null for fresh) and
 * returns a new settings object with the UserPromptSubmit hook ensured.
 *
 * Idempotent: if a hook with command containing "project-brain search" is
 * already present in UserPromptSubmit, it is not duplicated.
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

  // Get current UserPromptSubmit entries (ensure it's an array)
  const current: Array<Record<string, unknown>> = Array.isArray(hooks.UserPromptSubmit)
    ? (hooks.UserPromptSubmit as Array<Record<string, unknown>>)
    : [];

  // Idempotency check: skip if a project-brain search entry already exists
  const alreadyInstalled = current.some(
    (entry) =>
      typeof entry.command === "string" &&
      entry.command.includes("project-brain search")
  );

  if (!alreadyInstalled) {
    hooks.UserPromptSubmit = [...current, HOOK_ENTRY];
  } else {
    hooks.UserPromptSubmit = current;
  }

  return { ...base, hooks };
}
