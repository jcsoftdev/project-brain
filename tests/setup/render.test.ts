import { describe, it, expect } from "bun:test";

describe("renderStateLabel", () => {
  it("marks a unit that shipped after the last run as new", async () => {
    const { renderStateLabel } = await import("../../src/setup/render.js");
    expect(renderStateLabel("absent", "unseen")).toContain("NEW");
  });

  it("does not call an already-declined unit new", async () => {
    const { renderStateLabel } = await import("../../src/setup/render.js");
    expect(renderStateLabel("absent", "declined")).not.toContain("NEW");
    expect(renderStateLabel("absent", "declined")).toContain("not installed");
  });

  it("names every other state plainly", async () => {
    const { renderStateLabel } = await import("../../src/setup/render.js");
    expect(renderStateLabel("current", "selected")).toBe("current");
    expect(renderStateLabel("stale", "selected")).toBe("stale");
    expect(renderStateLabel("foreign", "selected")).toContain("left untouched");
    expect(renderStateLabel("unavailable", "unseen")).toContain("not available");
  });
});

describe("renderPlan", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "skill:x",
    label: "x",
    group: "Skills",
    description: "a skill",
    state: "absent" as const,
    membership: "unseen" as const,
    chosen: true,
    action: "install" as const,
    ...over,
  });

  it("groups the diff by action and counts the unchanged", async () => {
    const { renderPlan } = await import("../../src/setup/render.js");
    const text = renderPlan([
      row({ label: "brain-worktree", action: "install" }),
      row({ label: "brain-audit", action: "update" }),
      row({ label: "brain-okf", action: "remove" }),
      row({ label: "brain-commit", action: "unchanged" }),
      row({ label: "brain-record", action: "unchanged" }),
    ]);

    expect(text).toContain("+ install");
    expect(text).toContain("brain-worktree");
    expect(text).toContain("~ update");
    expect(text).toContain("- remove");
    expect(text).toContain("2 units");
  });

  it("says nothing will change when the plan is empty of work", async () => {
    const { renderPlan } = await import("../../src/setup/render.js");
    expect(renderPlan([row({ action: "unchanged" })])).toContain("Nothing to change");
  });
});
