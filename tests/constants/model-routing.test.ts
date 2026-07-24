import { describe, it, expect } from "bun:test";
import { MODEL_ROUTING, renderModelRoutingTable } from "../../src/constants.js";

describe("MODEL_ROUTING", () => {
  it("is a non-empty array of task/model/why entries", () => {
    expect(Array.isArray(MODEL_ROUTING)).toBe(true);
    expect(MODEL_ROUTING.length).toBeGreaterThan(0);
    for (const entry of MODEL_ROUTING) {
      expect(typeof entry.task).toBe("string");
      expect(["haiku", "sonnet", "opus"]).toContain(entry.model);
      expect(typeof entry.why).toBe("string");
    }
  });
});

describe("renderModelRoutingTable", () => {
  it("renders a markdown table with header and separator rows", () => {
    const table = renderModelRoutingTable();
    const lines = table.split("\n");
    expect(lines[0]).toBe("| Task | Model | Why |");
    expect(lines[1]).toMatch(/^\|[\s-]*\|[\s-]*\|[\s-]*\|$/);
  });

  it("renders one row per MODEL_ROUTING entry", () => {
    const table = renderModelRoutingTable();
    const lines = table.split("\n");
    // header + separator + one row per entry
    expect(lines.length).toBe(2 + MODEL_ROUTING.length);
  });

  it("includes every task, model, and why from MODEL_ROUTING", () => {
    const table = renderModelRoutingTable();
    for (const entry of MODEL_ROUTING) {
      expect(table).toContain(entry.task);
      expect(table).toContain(entry.model);
      expect(table).toContain(entry.why);
    }
  });
});
