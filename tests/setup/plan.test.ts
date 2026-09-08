import { describe, it, expect } from "bun:test";

describe("initialChecked", () => {
  it("uses the saved selection when there is one", async () => {
    const { initialChecked } = await import("../../src/setup/plan.js");
    expect(initialChecked("current", "selected", true)).toBe(true);
    expect(initialChecked("current", "declined", true)).toBe(false);
  });

  it("seeds an unseen unit from what is already on disk", async () => {
    const { initialChecked } = await import("../../src/setup/plan.js");
    // This is the migration path: a prior install with no selection file must
    // not lose anything just because the user upgraded into the picker.
    expect(initialChecked("current", "unseen", false)).toBe(true);
    expect(initialChecked("stale", "unseen", false)).toBe(true);
  });

  it("falls back to the unit default when it is absent and unseen", async () => {
    const { initialChecked } = await import("../../src/setup/plan.js");
    expect(initialChecked("absent", "unseen", true)).toBe(true);
    expect(initialChecked("absent", "unseen", false)).toBe(false);
  });

  it("never checks a unit that cannot be applied here", async () => {
    const { initialChecked } = await import("../../src/setup/plan.js");
    expect(initialChecked("unavailable", "selected", true)).toBe(false);
    expect(initialChecked("foreign", "selected", true)).toBe(false);
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
