/**
 * The auto-compact window setup writes into Claude Code's `settings.json`.
 *
 * Every request re-sends the whole conversation, read back at the cache rate,
 * and those reads count against a plan's usage limit. A 1M-context model left
 * on its default compacts near 967K tokens, so a long session spends most of
 * its turns re-reading a context several times larger than the work needs.
 * Capping the window at 400K makes compaction fire around 387K instead.
 *
 * 400K rather than lower because each compaction is itself a request that
 * reads the whole context and drops detail: at 200K a long task compacts so
 * often that the summaries cost more than they save. A 200K model is
 * unaffected — Claude Code caps the setting at the model's real window.
 *
 * It is written as the `autoCompactWindow` setting, not the
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var, on purpose: the env var outranks
 * the `--autocompact` flag, the setting does not. That keeps a per-session
 * escape hatch — `claude --autocompact 1000000` — for the rare task that needs
 * the whole window.
 */
export const AUTO_COMPACT_WINDOW = 400_000;

export const AUTO_COMPACT_KEY = "autoCompactWindow";

export const FULL_WINDOW_HINT = "claude --autocompact 1000000";

export type AutoCompactState = "absent" | "current" | "foreign";

/**
 * Any other value in the key is a choice the user made, and it is theirs:
 * reported as `foreign` so setup neither overwrites nor removes it.
 */
export function autoCompactState(settings: Record<string, unknown> | null): AutoCompactState {
  const value = settings?.[AUTO_COMPACT_KEY];
  if (value === undefined) return "absent";
  return value === AUTO_COMPACT_WINDOW ? "current" : "foreign";
}

export function withAutoCompact(settings: Record<string, unknown> | null): Record<string, unknown> {
  return { ...(settings ?? {}), [AUTO_COMPACT_KEY]: AUTO_COMPACT_WINDOW };
}

export function withoutAutoCompact(settings: Record<string, unknown>): Record<string, unknown> {
  if (autoCompactState(settings) !== "current") return settings;
  const { [AUTO_COMPACT_KEY]: _, ...rest } = settings;
  return rest;
}
