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
 * The checklist for every installable unit — one multiselect per group, asked
 * in order, driven by each unit's inspected state.
 *
 * It is split per group rather than presented as one flat list because a flat
 * list of eighteen `Group · Label` rows reads as a single all-or-nothing
 * question: the fast path is Enter, and Enter on a first run means every
 * default installs without anyone deciding anything. Four short, titled
 * questions make the same decision one group at a time, and each group can say
 * what it actually does before asking.
 *
 * Non-interactive resolves to the ticks it was handed, so a scripted run
 * applies the saved selection or the defaults without hanging on input.
 * Cancelling resolves to `null`, which the caller treats as "write nothing" —
 * an interrupted user consented to no home-directory change, and this prompt
 * can now authorise deletions.
 */
export async function promptUnitSelection(
  rows: Omit<PlanRow, "action">[],
  seed?: ReadonlySet<string>
): Promise<string[] | null> {
  const preselected = rows.filter((r) => r.chosen).map((r) => r.id);
  if (!isInteractive()) return preselected;

  // `seed` exists because the ticks a human is shown and the ticks a scripted
  // run applies are not the same answer — see `promptSeed`. Without one, the
  // row's own `chosen` is the seed, which keeps every existing caller and test
  // behaving exactly as before.
  const ticked = (row: Omit<PlanRow, "action">) => (seed ? seed.has(row.id) : row.chosen);

  const clack = await import("@clack/prompts");

  const sections = groupRowsForPrompt(rows);
  const promptable = sections.filter((s) => s.selectable.length > 0);
  const chosen = new Set<string>();

  let index = 0;
  for (const section of sections) {
    // Logged per group rather than all up front: a host that is not installed
    // here belongs next to the host list, not stranded above every question.
    for (const excluded of section.excluded) {
      clack.log.info(`${excluded.label}: ${renderStateLabel(excluded.state, excluded.membership)}`);
    }
    if (section.selectable.length === 0) continue;

    index += 1;
    const answer = await clack.multiselect({
      message: `${section.group} (${index}/${promptable.length}) — ${section.blurb}`,
      options: section.selectable.map((row) => ({
        value: row.id,
        label: row.label,
        hint: `${renderStateLabel(row.state, row.membership)} — ${row.description ?? ""}`.trim(),
      })),
      initialValues: section.selectable.filter(ticked).map((r) => r.id),
      required: false,
    });

    // Cancelling any one group cancels the run. Half a consent is not a
    // consent: the caller's "write nothing" exit is the only honest reading of
    // an interrupted checklist.
    if (clack.isCancel(answer)) return null;
    for (const id of answer as string[]) chosen.add(id);
  }

  // Rebuilt from `rows` rather than concatenated per group, so the returned
  // order always matches the inspected order the caller planned against.
  return rows.filter((r) => chosen.has(r.id)).map((r) => r.id);
}

/** One prompt's worth of rows: the group, what it is, and what can be ticked. */
export interface PromptSection {
  group: string;
  blurb: string;
  selectable: Omit<PlanRow, "action">[];
  excluded: Omit<PlanRow, "action">[];
}

/**
 * What each group is, in one line, shown as the prompt's own question.
 *
 * A single flat checklist made "Hosts · Claude Code" and "Skills · brain-okf"
 * look like the same kind of decision. They are not: one registers an MCP
 * server with an editor, the other drops a skill file on disk. Splitting the
 * checklist per group is only useful if each group says what it is.
 */
const GROUP_BLURBS: Record<string, string> = {
  Hosts: "AI tools that get the MCP server registered and a rules file written",
  Guidance: "rules and hooks written into those tools",
  Skills: "skills installed for every detected tool",
  Other: "machine-wide extras",
};

const GROUP_ORDER = ["Hosts", "Guidance", "Skills", "Other"];

/**
 * Split the inspected rows into one section per group, in a stable order.
 *
 * Pure and exported so the ordering and the selectable/excluded partition are
 * testable without a terminal — the `@clack/prompts` path above cannot be.
 * An unknown group (one added to a unit without being added here) is kept and
 * appended rather than dropped, so a new group is merely unsorted, never
 * silently unofferable.
 */
export function groupRowsForPrompt(rows: Omit<PlanRow, "action">[]): PromptSection[] {
  const isUnselectable = (row: Omit<PlanRow, "action">) =>
    row.state === "unavailable" || row.state === "foreign";

  const seen: string[] = [];
  for (const row of rows) if (!seen.includes(row.group)) seen.push(row.group);

  const ordered = [
    ...GROUP_ORDER.filter((g) => seen.includes(g)),
    ...seen.filter((g) => !GROUP_ORDER.includes(g)),
  ];

  return ordered.map((group) => {
    const inGroup = rows.filter((r) => r.group === group);
    return {
      group,
      blurb: GROUP_BLURBS[group] ?? "",
      selectable: inGroup.filter((r) => !isUnselectable(r)),
      excluded: inGroup.filter(isUnselectable),
    };
  });
}
