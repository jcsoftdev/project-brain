import { describe, it, expect } from "bun:test";

describe("initialChecked", () => {
  it("uses the saved selection when there is one", async () => {
    const { initialChecked } = await import("../../src/setup/plan.js");
    expect(initialChecked("current", "selected", true, true)).toBe(true);
    expect(initialChecked("current", "declined", true, true)).toBe(false);
  });

  it("seeds an unseen unit from what is already on disk (migration, no selection file)", async () => {
    const { initialChecked } = await import("../../src/setup/plan.js");
    // This is the migration path: a prior install with no selection file must
    // not lose anything just because the user upgraded into the picker. The
    // current/stale branch must win even though hasSelection is false here.
    expect(initialChecked("current", "unseen", false, false)).toBe(true);
    expect(initialChecked("stale", "unseen", false, false)).toBe(true);
  });

  it("falls back to the unit default when absent, unseen, and there is no selection file yet (first run)", async () => {
    const { initialChecked } = await import("../../src/setup/plan.js");
    expect(initialChecked("absent", "unseen", true, false)).toBe(true);
    expect(initialChecked("absent", "unseen", false, false)).toBe(false);
  });

  // Critical B: a unit in neither list, with a selection file already on
  // disk, is genuinely new — it must render unchecked regardless of the
  // unit's own default, or a newly shipped unit installs itself silently on
  // the next non-interactive run.
  it("renders unchecked when unseen AND a selection file exists, regardless of defaultSelected", async () => {
    const { initialChecked } = await import("../../src/setup/plan.js");
    expect(initialChecked("absent", "unseen", true, true)).toBe(false);
    expect(initialChecked("absent", "unseen", false, true)).toBe(false);
  });

  it("never checks a unit that cannot be applied here", async () => {
    const { initialChecked } = await import("../../src/setup/plan.js");
    expect(initialChecked("unavailable", "selected", true, true)).toBe(false);
    expect(initialChecked("foreign", "selected", true, true)).toBe(false);
  });
});

describe("computePlan", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "skill:x",
    label: "x",
    group: "Skills",
    description: "a skill",
    state: "absent" as const,
    membership: "unseen" as const,
    chosen: true,
    ...over,
  });

  it("classifies each row into the action the confirm screen shows", async () => {
    const { computePlan } = await import("../../src/setup/plan.js");
    const plan = computePlan([
      row({ id: "a", state: "absent", chosen: true }),
      row({ id: "b", state: "stale", chosen: true }),
      row({ id: "c", state: "current", chosen: true }),
      row({ id: "d", state: "current", chosen: false }),
      row({ id: "e", state: "absent", chosen: false }),
      row({ id: "f", state: "foreign", chosen: true }),
      row({ id: "g", state: "unavailable", chosen: true }),
    ]);

    const byId = Object.fromEntries(plan.map((p) => [p.id, p.action]));
    expect(byId).toEqual({
      a: "install",
      b: "update",
      c: "unchanged",
      d: "remove",
      e: "unchanged",
      f: "blocked",
      g: "unchanged",
    });
  });

  it("never plans a removal for a directory we do not own", async () => {
    const { computePlan } = await import("../../src/setup/plan.js");
    const plan = computePlan([row({ id: "f", state: "foreign", chosen: false })]);
    expect(plan[0]!.action).toBe("blocked");
  });

  it("declining a unit that cannot be applied here must not plan a removal", async () => {
    const { computePlan } = await import("../../src/setup/plan.js");
    const plan = computePlan([row({ id: "u", state: "unavailable", chosen: false })]);
    expect(plan[0]!.action).toBe("unchanged");
  });

  it("deselecting a stale unit must plan a removal", async () => {
    const { computePlan } = await import("../../src/setup/plan.js");
    const plan = computePlan([row({ id: "s", state: "stale", chosen: false })]);
    expect(plan[0]!.action).toBe("remove");
  });
});
