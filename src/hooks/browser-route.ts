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
  "project-brain browser route: chrome-devtools drives one shared headless browser on a dedicated " +
  "persistent profile (sign in once with `project-brain browser login`). Reuse it, open your own " +
  "page and close it when you are done; for a separate session on the same URL pass " +
  "`isolatedContext` to `new_page`. The owner's real Chrome only if the owner explicitly asks.";

/**
 * The notice for this payload, or null when it is not a chrome-devtools call. `overBudget` adds
 * the one fact the agent can act on: tell the owner, who restarts it when nothing is running.
 */
export function browserRouteNotice(payload: unknown, overBudget?: { rssMb: number; maxMb: number }): string | null {
  const toolName = (payload as { tool_name?: unknown } | null)?.tool_name;
  if (typeof toolName !== "string" || !toolName.startsWith(BROWSER_TOOL_PREFIX)) return null;
  return overBudget
    ? `${BROWSER_ROUTE_NOTICE} The shared server is at ${overBudget.rssMb} MB (budget ${overBudget.maxMb} MB): ` +
        `mention it to the owner, who restarts it when no session is mid-task (\`project-brain browser status\`).`
    : BROWSER_ROUTE_NOTICE;
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
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    if (browserRouteNotice(payload) && sessionId && (await claimSession(dataDir, sessionId))) {
      const { probeSharedServer } = await import("../browser/probe.js");
      const budget = probeSharedServer(dataDir)?.budget;
      const notice = browserRouteNotice(payload, budget?.over ? budget : undefined)!;
      process.stdout.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notice } })}\n`
      );
    }
  } catch {
    // Never fail the tool call over a reminder.
  }
  process.exit(0);
}
