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
 *
 * `hasSelection` disambiguates the two facts `membership === "unseen"` alone
 * cannot tell apart: "there is no selection file at all" (a first run, where
 * `defaultSelected` should apply) versus "there IS a file and this id is in
 * neither list" (genuinely new — shipped after the user's last run). Only the
 * first case may fall through to `defaultSelected`; the second must render
 * unchecked, or a newly shipped unit installs itself on the next
 * non-interactive run without ever being offered.
 */
export function initialChecked(
  state: UnitState,
  membership: Membership,
  defaultSelected: boolean,
  hasSelection: boolean
): boolean {
  // A unit that cannot be applied here is never offered as checked, whatever
  // the saved selection says — it would plan work that cannot happen.
  if (state === "unavailable" || state === "foreign") return false;
  if (membership === "selected") return true;
  if (membership === "declined") return false;
  // Migration path: on-disk state wins over hasSelection, so an upgrade with
  // no selection file yet loses nothing.
  if (state === "current" || state === "stale") return true;
  // Genuinely new: a selection file exists and never offered this id.
  if (membership === "unseen" && hasSelection) return false;
  return defaultSelected;
}

/**
 * Whether a unit's checkbox starts ticked *in the interactive checklist*.
 *
 * Deliberately not the same answer as `initialChecked`, and the difference is
 * the whole point: `initialChecked` decides what a run with no human applies,
 * so on a first run it must fall through to `defaultSelected` or a scripted
 * install would install nothing. The checklist has a human in front of it, and
 * pre-ticking every default there turns the one question we ask into a single
 * Enter that installs eighteen things nobody chose.
 *
 * So on a first run (no selection file) only what is ALREADY on disk starts
 * ticked — Enter then changes nothing, and every install is something the user
 * actually ticked. Once a selection file exists the two agree completely:
 * the saved answer is the seed.
 */
export function promptSeed(
  state: UnitState,
  membership: Membership,
  defaultSelected: boolean,
  hasSelection: boolean
): boolean {
  if (state === "unavailable" || state === "foreign") return false;
  if (!hasSelection) return state === "current" || state === "stale";
  return initialChecked(state, membership, defaultSelected, hasSelection);
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
