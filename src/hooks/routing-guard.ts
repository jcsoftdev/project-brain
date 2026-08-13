/**
 * PreToolUse guard: refuse a sub-agent spawn that names no model.
 *
 * Verified empirically before this was built — PreToolUse DOES fire on the
 * spawn tool, and its payload carries `tool_input.model` and
 * `tool_input.description`. (The event's docs list matcher examples only, and
 * one reading of them suggests sub-agents are not tools. They are.)
 *
 * Exit code 2 is the block channel, not `permissionDecision: "deny"`: the JSON
 * decision has been reported as ignored, while exit 2 blocks the call and hands
 * stderr to the model as the reason — which is exactly the retry prompt we
 * want. PreToolUse supports neither `additionalContext` nor `updatedInput`, so
 * blocking with a reason is the ONLY way this hook can teach anything.
 */

const SPAWN_TOOLS = new Set(["Task", "Agent"]);

export interface GuardDecision {
  block: boolean;
  reason?: string;
}

const ALLOW: GuardDecision = { block: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decide whether to block, from a PreToolUse payload.
 *
 * Fails OPEN on anything unexpected. A guard that blocks because it could not
 * parse its own input is worse than no guard: it breaks delegation entirely,
 * and the user's only fix is to uninstall it.
 */
export function routingGuardDecision(payload: unknown): GuardDecision {
  if (!isPlainObject(payload)) return ALLOW;

  const toolName = payload.tool_name;
  if (typeof toolName !== "string" || !SPAWN_TOOLS.has(toolName)) return ALLOW;

  const input = payload.tool_input;
  if (!isPlainObject(input)) return ALLOW;

  const model = input.model;
  const named = typeof model === "string" && model.trim().length > 0;
  if (named) return ALLOW;

  return {
    block: true,
    reason:
      "This delegation names no model, so it inherits the session's — which is the " +
      "expensive default for cheap work. Re-issue it with an explicit model: fast for " +
      "lookups and mechanical edits, balanced for implementation and review, deep for " +
      "tradeoffs and adversarial verification. Prefix the description with the model " +
      "you picked (e.g. `haiku: locate auth handler`) so the choice is visible. " +
      "If inheriting really is the right call, say so in the description.",
  };
}

/** CLI entry point: read the hook payload on stdin, exit 2 to block. */
export async function execute(): Promise<void> {
  let payload: unknown = null;
  try {
    const raw = await Bun.stdin.text();
    payload = JSON.parse(raw);
  } catch {
    // Unreadable or non-JSON stdin — allow, per fail-open.
    process.exit(0);
  }

  const decision = routingGuardDecision(payload);
  if (!decision.block) process.exit(0);

  process.stderr.write(`${decision.reason}\n`);
  process.exit(2);
}
