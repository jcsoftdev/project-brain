import type { PlanRow } from "./plan.js";
import type { UnitState } from "./units.js";
import type { Membership } from "./selection.js";

/**
 * The right-hand column of the checklist.
 *
 * `NEW` is the whole reason this is not a plain state name. A unit that is
 * absent because the user declined it reads "not installed"; one that is absent
 * because it shipped since their last run reads "NEW", and that difference is
 * what replaces the silent auto-add `refreshStaleSkills` used to perform.
 */
export function renderStateLabel(state: UnitState, membership: Membership): string {
  switch (state) {
    case "current":
      return "current";
    case "stale":
      return "stale";
    case "foreign":
      return "foreign — left untouched";
    case "unavailable":
      return "not available on this machine";
    case "absent":
      return membership === "unseen" ? "NEW" : "not installed";
  }
}

const HEADINGS: Record<string, string> = {
  install: "  + install   ",
  update: "  ~ update    ",
  remove: "  - remove    ",
  blocked: "  ! skipped   ",
};

/**
 * The confirmation shown before a single write happens.
 *
 * Grouped by action rather than listed per unit: what a user needs to check
 * before saying yes is "what disappears", and a flat list buries one removal
 * among a dozen no-ops.
 */
export function renderPlan(plan: PlanRow[]): string {
  const lines: string[] = ["Changes:"];

  for (const action of ["install", "update", "remove", "blocked"] as const) {
    const labels = plan.filter((p) => p.action === action).map((p) => p.label);
    if (labels.length > 0) lines.push(`${HEADINGS[action]}${labels.join(", ")}`);
  }

  const unchanged = plan.filter((p) => p.action === "unchanged").length;
  if (lines.length === 1) return "Nothing to change. Everything is already as selected.";
  if (unchanged > 0) lines.push(`  = unchanged  ${unchanged} units`);

  return lines.join("\n");
}
