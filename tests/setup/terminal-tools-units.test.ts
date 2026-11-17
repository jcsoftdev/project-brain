import { describe, expect, it } from "bun:test";
import { allUnits, terminalToolUnits, type SetupContext } from "../../src/setup/units.js";

const IDS = ["terminal:bat-theme", "terminal:fzf-theme", "terminal:lazygit-theme", "terminal:tmux-theme", "terminal:starship-theme"];

describe("terminal tool theme units", () => {
  it("are five opt-in units of their own group, each saying how to undo it", () => {
    const units = terminalToolUnits();
    expect(units.map((u) => u.id)).toEqual(IDS);
    for (const unit of units) {
      expect(unit.group).toBe("Terminal tools");
      expect(unit.defaultSelected).toBe(false);
      expect(unit.description.length).toBeGreaterThan(40);
    }
  });

  it("are part of every setup run, and no id is used twice", () => {
    const ctx = { dataDir: "/tmp/x", installed: [], claudeSettingsPath: "/tmp/x/.claude/settings.json", routingConfigPath: "/tmp/none.json" } as unknown as SetupContext;
    const ids = allUnits(ctx).map((u) => u.id);
    for (const id of IDS) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
