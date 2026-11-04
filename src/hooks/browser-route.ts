/**
 * PreToolUse notice: say, once per session, which browser a chrome-devtools call lands in.
 *
 * Without it the agent guesses the route from tool names alone, and the wrong guess is
 * expensive either way: a second browser per session, or a click inside the owner's real
 * signed-in Chrome. PreToolUse accepts `additionalContext` (as `arch-guard` uses it), so the
 * line is delivered next to the first browser call and never blocks it.
 *
 * Whether the installed server is attached to the owner's Chrome is deliberately not said:
 * that lives in a launchd or systemd definition under a label the user may have chosen, and
 * a hook that guesses it wrong tells the agent something false.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../constants.js";

const BROWSER_TOOL_PREFIX = "mcp__chrome-devtools__";

export const BROWSER_ROUTE_NOTICE =
  "project-brain browser route: chrome-devtools drives one shared headless browser by default. " +
  "Reuse it, open your own page and close it when you are done. For a separate session on the " +
  "same URL (own cookies and storage) pass `isolatedContext` to `new_page` instead of starting " +
  "another browser. The owner's real signed-in Chrome is for when the owner explicitly asks.";

/** The notice for this payload, or null when it is not a chrome-devtools call. */
export function browserRouteNotice(payload: unknown): string | null {
  const toolName = (payload as { tool_name?: unknown } | null)?.tool_name;
  return typeof toolName === "string" && toolName.startsWith(BROWSER_TOOL_PREFIX)
    ? BROWSER_ROUTE_NOTICE
    : null;
}

/**
 * Whether this is the session's first browser call, recording it when so. `wx` makes the claim
 * atomic, so two calls racing in one session cannot both print. A failure to record shows the
 * notice again, which beats losing it (`task-switch`'s trade).
 */
export async function claimSession(dataDir: string, sessionId: string): Promise<boolean> {
  const dir = join(dataDir, "browser-route");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId.replace(/[^\w-]/g, "_")}.json`), "{}", { flag: "wx" });
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "EEXIST";
  }
}

/** CLI entry point: read the hook payload on stdin; always exit 0. */
export async function execute(dataDir: string = DATA_DIR): Promise<void> {
  try {
    const payload = JSON.parse(await Bun.stdin.text()) as { session_id?: unknown };
    const notice = browserRouteNotice(payload);
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    if (notice && sessionId && (await claimSession(dataDir, sessionId))) {
      process.stdout.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notice } })}\n`
      );
    }
  } catch {
    // Never fail the tool call over a reminder.
  }
  process.exit(0);
}
