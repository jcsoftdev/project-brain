/**
 * SessionStart hook: inject the model-routing rules once per session.
 *
 * SessionStart is one of the few events that accept `additionalContext`
 * (with UserPromptSubmit and PostToolUse) — and the only one of those that
 * fires once rather than once per prompt. Written guidance in a rules file can
 * be skimmed past; this lands in context every session, at a cost paid once.
 *
 * Output is capped at 10,000 characters by the host. That is a ceiling, not a
 * budget: what goes in is the table and the label rule, because the session
 * pays for every character. The prose lives in the rules file.
 */

import { ROUTING_TIERS, DEFAULT_HOST_MODELS } from "../constants.js";
import { loadRoutingConfig } from "../rules/model-routing-config.js";

/** Build the SessionStart hook payload as a JSON string. */
export async function buildRoutingReminder(configPath?: string): Promise<string> {
  const resolved = await loadRoutingConfig(configPath);
  const models = resolved.models.claude ?? DEFAULT_HOST_MODELS.claude!;

  const tiers = ROUTING_TIERS.map((t) => `- ${t.tier}: ${t.meaning}`).join("\n");
  const named = Object.values(models).some((m) => m !== null);
  const header = named ? "| Task | Tier | Model | Why |" : "| Task | Tier | Why |";
  const separator = named ? "| --- | --- | --- | --- |" : "| --- | --- | --- |";
  const rows = resolved.rules.map((r) =>
    named
      ? `| ${r.task} | ${r.tier} | ${models[r.tier] ?? "—"} | ${r.why} |`
      : `| ${r.task} | ${r.tier} | ${r.why} |`
  );

  const additionalContext = [
    "Model routing for delegated agents — pick a sub-agent's model deliberately.",
    "",
    tiers,
    "",
    [header, separator, ...rows].join("\n"),
    "",
    "Pass `model` on the delegation call, and prefix the description with it " +
      "(`haiku: locate auth handler`) so the choice is visible. Raise reasoning effort " +
      "before raising tier. Delegate only when the work is 4+ files or a read-then-write " +
      "pair; 1-3 files to decide is cheaper inline.",
  ].join("\n");

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  });
}

/** CLI entry point: print the payload for the SessionStart hook. */
export async function execute(): Promise<void> {
  // Never let a hook failure interrupt a session start — print nothing and go.
  try {
    console.log(await buildRoutingReminder());
  } catch {
    process.exit(0);
  }
}
