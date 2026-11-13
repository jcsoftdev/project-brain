/**
 * PreToolUse hook: append the report contract to every delegation prompt.
 *
 * `updatedInput` replaces the WHOLE tool input, so every other field is copied
 * through. No `permissionDecision` is returned on purpose: `allow` would also skip
 * the permission prompt, and a hook that only edits text must not widen what a
 * call is allowed to do.
 *
 * Fails open: anything unexpected prints nothing, and the call goes out as written.
 */

import { withReportContract } from "../rules/report-contract.js";

const SPAWN_TOOLS = new Set(["Task", "Agent"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The hook's stdout for a PreToolUse payload, or null when the call should pass unchanged. */
export function reportContractOutput(payload: unknown): object | null {
  if (!isPlainObject(payload)) return null;
  if (typeof payload.tool_name !== "string" || !SPAWN_TOOLS.has(payload.tool_name)) return null;

  const input = payload.tool_input;
  if (!isPlainObject(input) || typeof input.prompt !== "string") return null;

  const prompt = withReportContract(input.prompt);
  if (prompt === input.prompt) return null;

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...input, prompt },
    },
  };
}

export async function execute(): Promise<void> {
  try {
    const output = reportContractOutput(JSON.parse(await Bun.stdin.text()));
    if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    // Unreadable stdin: the delegation goes out unchanged.
  }
  process.exit(0);
}
