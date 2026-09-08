import type { UnitState } from "./units.js";
import type { Membership } from "./selection.js";

export type Action = "install" | "update" | "remove" | "unchanged" | "blocked";

export interface PlanRow {
  id: string;
  label: string;
  group: string;
  /** The unit's one-line description, carried so the checklist need not re-widen. */
  description: string;
  state: UnitState;
  membership: Membership;
  chosen: boolean;
  action: Action;
}

/**
 * Whether a unit's checkbox starts ticked.
 *
 * The `unseen` branch is the migration path and the reason this is a function
 * rather than a lookup on the selection file. Someone upgrading into this
 * feature has no selection file, but they DO have things on disk they
 * consented to under the old flow — so anything installed starts checked, and
 * only a genuinely absent unit falls through to its default. Nothing is removed
 * as a side effect of upgrading.
 */
export function initialChecked(
  state: UnitState,
  membership: Membership,
  defaultSelected: boolean
): boolean {
  // A unit that cannot be applied here is never offered as checked, whatever
  // the saved selection says — it would plan work that cannot happen.
  if (state === "unavailable" || state === "foreign") return false;
  if (membership === "selected") return true;
  if (membership === "declined") return false;
  if (state === "current" || state === "stale") return true;
  return defaultSelected;
}

/**
 * Turn inspected states plus the user's ticks into the diff shown before any
 * write happens.
 *
 * `blocked` exists so a `foreign` directory can be reported rather than
 * silently dropped: the user sees that we found something we did not write and
 * left it alone, which is the difference between a considered skip and a bug.
 */
export function computePlan(rows: Omit<PlanRow, "action">[]): PlanRow[] {
  return rows.map((row) => ({ ...row, action: actionFor(row) }));
}

function actionFor(row: Omit<PlanRow, "action">): Action {
  if (row.state === "foreign") return "blocked";
  if (row.state === "unavailable") return "unchanged";

  if (row.chosen) {
    if (row.state === "absent") return "install";
    if (row.state === "stale") return "update";
    return "unchanged";
  }

  return row.state === "absent" ? "unchanged" : "remove";
}
