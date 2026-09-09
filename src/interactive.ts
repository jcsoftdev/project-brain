/**
 * Interactive CLI prompts, isolated from setup.ts so the @clack/prompts import
 * only happens lazily and only when the TTY guard actually needs it.
 */

import type { PlanRow } from "./setup/plan.js";
import { renderStateLabel } from "./setup/render.js";

/**
 * True only in a real interactive session — both stdio streams attached, not
 * CI. Exported so every gate on "should we prompt" (the unit checklist, and
 * the confirm screen in `src/commands/setup.ts`) shares one definition rather
 * than each writing its own TTY check.
 */
export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY) && !process.env.CI;
}

/**
 * The one checklist prompt for every installable unit — it replaced the old
 * per-feature opt-in/opt-out prompts (skill install, model-routing guidance)
 * with a single multiselect driven by each unit's inspected state.
 *
 * Non-interactive resolves to the ticks it was handed, so a scripted run
 * applies the saved selection or the defaults without hanging on input.
 * Cancelling resolves to `null`, which the caller treats as "write nothing" —
 * an interrupted user consented to no home-directory change, and this prompt
 * can now authorise deletions.
 */
export async function promptUnitSelection(
  rows: Omit<PlanRow, "action">[]
): Promise<string[] | null> {
  const preselected = rows.filter((r) => r.chosen).map((r) => r.id);
  if (!isInteractive()) return preselected;

  const clack = await import("@clack/prompts");

  // One partition, not two independent filters: the excluded set and the
  // logged set must never drift apart, or a unit ends up either logged and
  // still offered, or excluded with no explanation.
  const isUnselectable = (row: Omit<PlanRow, "action">) =>
    row.state === "unavailable" || row.state === "foreign";
  const excluded = rows.filter(isUnselectable);
  const selectable = rows.filter((r) => !isUnselectable(r));

  for (const row of excluded) {
    clack.log.info(`${row.label}: ${renderStateLabel(row.state, row.membership)}`);
  }

  const answer = await clack.multiselect({
    message: "Select what project-brain should install and keep up to date",
    options: selectable.map((row) => ({
      value: row.id,
      label: `${row.group} · ${row.label}`,
      hint: `${renderStateLabel(row.state, row.membership)} — ${row.description ?? ""}`.trim(),
    })),
    initialValues: selectable.filter((r) => r.chosen).map((r) => r.id),
    required: false,
  });

  if (clack.isCancel(answer)) return null;
  return answer as string[];
}
