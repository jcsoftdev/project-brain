/**
 * One-time upgrade path for the global suggestion hook.
 *
 * `setup` installs `project-brain suggest --stdin` for new users, but an existing
 * install will not rerun it. The routing SessionStart hook (`routing-rules`) is the
 * one `setup` selects by default and the one that already runs once per session for
 * them, so it carries this: if the suggestion hook is absent AND the marker says it
 * was never installed or declined, add it once.
 *
 * The marker is the guard against re-adding. It exists as soon as the hook was
 * installed (by setup or here) or declined (setup, whether by unticking or removing),
 * so removing the hook by hand, or deselecting it later, is final. The saved setup
 * selection is checked as well, for a decline recorded before the marker existed.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { SUGGEST_COMMAND, upsertSuggestHook } from "./claude-settings.js";

export type SuggestHookState = "installed" | "opted-out";

export function suggestMarkerPath(dataDir: string): string {
  return join(dataDir, "suggest-hook.json");
}

export async function readSuggestMarker(dataDir: string): Promise<SuggestHookState | null> {
  try {
    const parsed = JSON.parse(await readFile(suggestMarkerPath(dataDir), "utf-8")) as { state?: unknown };
    return parsed.state === "installed" || parsed.state === "opted-out" ? parsed.state : null;
  } catch {
    return null;
  }
}

export async function writeSuggestMarker(dataDir: string, state: SuggestHookState): Promise<void> {
  await writeFileAtomic(suggestMarkerPath(dataDir), `${JSON.stringify({ state, at: new Date().toISOString() })}\n`);
}

/** True when the saved setup selection lists the unit as declined: the user unticked it. */
async function declinedInSetup(selectionPath: string): Promise<boolean> {
  const { loadSelection } = await import("../setup/selection.js");
  return (await loadSelection(selectionPath))?.declined.includes("hooks:suggest") ?? false;
}

/**
 * Add the hook to the user's settings once. Returns whether it wrote the settings.
 * Does nothing when the marker exists, setup recorded a decline, the settings are
 * missing or unparseable, or the hook is already there (the marker is then recorded
 * so a later removal sticks). If the file changes while it is being read (another
 * tool editing settings.json) it re-reads once, then gives up for this session.
 * Never throws.
 */
export async function selfInstallSuggestHook(opts: {
  settingsPath: string;
  dataDir: string;
  selectionPath?: string;
  /** Test seam: runs right after settings.json was read, to simulate a concurrent edit. */
  afterRead?: () => Promise<void>;
}): Promise<boolean> {
  try {
    if ((await readSuggestMarker(opts.dataDir)) !== null) return false;
    if (await declinedInSetup(opts.selectionPath ?? join(opts.dataDir, "setup-selection.json"))) return false;

    // Write through a symlinked settings.json rather than replacing the link.
    const target = await realpath(opts.settingsPath);

    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await stat(target);
      const parsed: unknown = JSON.parse(await readFile(target, "utf-8"));
      await opts.afterRead?.();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;

      const present = JSON.stringify((parsed as { hooks?: unknown }).hooks ?? {}).includes(SUGGEST_COMMAND);
      if (!present) {
        const now = await stat(target);
        if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) continue;
        await writeFileAtomic(target, `${JSON.stringify(upsertSuggestHook(parsed), null, 2)}\n`);
      }
      await writeSuggestMarker(opts.dataDir, "installed");
      return !present;
    }
    return false;
  } catch {
    return false;
  }
}
