/**
 * The `attribution` setting that stops Claude Code from signing commits and PRs.
 *
 * The trailer (`Co-Authored-By`, `Claude-Session: <link>`) is appended by the
 * harness, not written by the model, so no rule in a skill or rules file can
 * keep it out — `brain-commit` already forbids it and it still appears. Only
 * the setting reaches the code that adds it, and an empty string is how that
 * setting says "nothing".
 */
export const ATTRIBUTION_KEY = "attribution";

const SILENT = { commit: "", pr: "" } as const;

export type AttributionState = "absent" | "current" | "foreign";

/** Text the user wrote into either field is their attribution, not ours. */
export function attributionState(settings: Record<string, unknown> | null): AttributionState {
  const value = settings?.[ATTRIBUTION_KEY] as Record<string, unknown> | undefined;
  if (value === undefined) return "absent";
  return value?.commit === "" && value?.pr === "" ? "current" : "foreign";
}

export function withoutAttribution(
  settings: Record<string, unknown> | null
): Record<string, unknown> {
  return { ...(settings ?? {}), [ATTRIBUTION_KEY]: { ...SILENT } };
}

export function withAttributionRestored(
  settings: Record<string, unknown>
): Record<string, unknown> {
  if (attributionState(settings) !== "current") return settings;
  const { [ATTRIBUTION_KEY]: _, ...rest } = settings;
  return rest;
}
