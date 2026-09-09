import { describe, it, expect } from "bun:test";
import { promptUnitSelection } from "../src/interactive.js";
import type { PlanRow } from "../src/setup/plan.js";

const row = (over: Partial<Omit<PlanRow, "action">>): Omit<PlanRow, "action"> => ({
  id: "skill:x",
  label: "x",
  group: "Skills",
  description: "a skill",
  state: "absent",
  membership: "unseen",
  chosen: false,
  ...over,
});

describe("promptUnitSelection", () => {
  /**
   * Everything before the `@clack/prompts` dynamic import is pure logic
   * reached without any terminal — process.stdout.isTTY is falsy under
   * `bun test`, so these run with no stub and no TTY.
   */
  it("passes through an empty array when no rows are chosen", async () => {
    expect(Boolean(process.stdout.isTTY)).toBe(false);
    const rows = [row({ id: "a", chosen: false }), row({ id: "b", chosen: false })];
    expect(await promptUnitSelection(rows)).toEqual([]);
  });

  it("passes through exactly the chosen ids, in row order, leaving unselectable rows alone", async () => {
    expect(Boolean(process.stdout.isTTY)).toBe(false);
    const rows = [
      row({ id: "a", chosen: true }),
      row({ id: "b", chosen: false, state: "unavailable" }),
      row({ id: "c", chosen: true }),
      row({ id: "d", chosen: false, state: "foreign" }),
    ];
    // Passthrough hands back exactly what it was given — it must not silently
    // apply the selectable filter used on the interactive path.
    expect(await promptUnitSelection(rows)).toEqual(["a", "c"]);
  });

  it("passes through every id when every row is chosen", async () => {
    expect(Boolean(process.stdout.isTTY)).toBe(false);
    const rows = [row({ id: "a", chosen: true }), row({ id: "b", chosen: true })];
    expect(await promptUnitSelection(rows)).toEqual(["a", "b"]);
  });

  it("takes the non-interactive path under CI without reading stdin, even with both streams TTY", async () => {
    const outTTY = process.stdout.isTTY;
    const inTTY = process.stdin.isTTY;
    const ci = process.env.CI;
    try {
      process.stdout.isTTY = true;
      process.stdin.isTTY = true;
      process.env.CI = "1";
      const rows = [row({ id: "a", chosen: true }), row({ id: "b", chosen: false })];
      // A hang here (waiting on @clack/prompts stdin) is the failure signal as
      // much as a wrong value is.
      expect(await promptUnitSelection(rows)).toEqual(["a"]);
    } finally {
      process.stdout.isTTY = outTTY;
      process.stdin.isTTY = inTTY;
      if (ci === undefined) delete process.env.CI;
      else process.env.CI = ci;
    }
  });
});

describe("groupRowsForPrompt", () => {
  it("orders groups Hosts, Guidance, Skills, Other regardless of row order", async () => {
    const { groupRowsForPrompt } = await import("../src/interactive.js");
    const rows = [
      row({ id: "s", group: "Skills" }),
      row({ id: "o", group: "Other" }),
      row({ id: "h", group: "Hosts" }),
      row({ id: "g", group: "Guidance" }),
    ];
    expect(groupRowsForPrompt(rows).map((s) => s.group)).toEqual([
      "Hosts",
      "Guidance",
      "Skills",
      "Other",
    ]);
  });

  it("omits a group with no rows instead of prompting for an empty list", async () => {
    const { groupRowsForPrompt } = await import("../src/interactive.js");
    const rows = [row({ id: "h", group: "Hosts" })];
    expect(groupRowsForPrompt(rows).map((s) => s.group)).toEqual(["Hosts"]);
  });

  it("appends an unrecognised group after the known ones, in first-seen order", async () => {
    const { groupRowsForPrompt } = await import("../src/interactive.js");
    const rows = [
      row({ id: "z", group: "Zzz" }),
      row({ id: "a", group: "Aaa" }),
      row({ id: "h", group: "Hosts" }),
    ];
    expect(groupRowsForPrompt(rows).map((s) => s.group)).toEqual(["Hosts", "Zzz", "Aaa"]);
  });

  it("splits each group into selectable and excluded rows, keeping row order", async () => {
    const { groupRowsForPrompt } = await import("../src/interactive.js");
    const rows = [
      row({ id: "h1", group: "Hosts" }),
      row({ id: "h2", group: "Hosts", state: "unavailable" }),
      row({ id: "h3", group: "Hosts" }),
      row({ id: "o1", group: "Other", state: "foreign" }),
    ];
    const sections = groupRowsForPrompt(rows);
    expect(sections[0]!.selectable.map((r) => r.id)).toEqual(["h1", "h3"]);
    expect(sections[0]!.excluded.map((r) => r.id)).toEqual(["h2"]);
    expect(sections[1]!.selectable).toEqual([]);
    expect(sections[1]!.excluded.map((r) => r.id)).toEqual(["o1"]);
  });

  it("carries a blurb for every known group so the prompt can say what it is", async () => {
    const { groupRowsForPrompt } = await import("../src/interactive.js");
    const rows = [
      row({ id: "h", group: "Hosts" }),
      row({ id: "g", group: "Guidance" }),
      row({ id: "s", group: "Skills" }),
      row({ id: "o", group: "Other" }),
    ];
    for (const section of groupRowsForPrompt(rows)) {
      expect(section.blurb.length).toBeGreaterThan(0);
    }
  });
});
