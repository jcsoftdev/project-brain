import { test, expect, describe } from "bun:test";
import {
  TOOL_CATALOG,
  renderToolList,
  renderToolDocs,
  SERVER_INSTRUCTIONS,
} from "../src/constants.js";

const ALL_TOOLS = [
  "search_context",
  "search_code",
  "expand_context",
  "find_symbol",
  "find_callers",
  "find_callees",
  "impact",
  "trace_path",
  "list_modules",
  "get_module",
  "add_knowledge",
  "delete_knowledge",
  "check_health",
  "list_projects",
  "delete_project",
  "manage_adr",
  "get_architecture",
  "sync_project",
];

describe("tool catalog is the single source of truth", () => {
  test("TOOL_CATALOG contains every tool the server registers", () => {
    const names = TOOL_CATALOG.map((t) => t.name);
    for (const t of ALL_TOOLS) expect(names).toContain(t);
    expect(names.length).toBe(ALL_TOOLS.length);
  });

  test("SERVER_INSTRUCTIONS is derived from the catalog (lists every tool)", () => {
    for (const t of ALL_TOOLS) expect(SERVER_INSTRUCTIONS).toContain(t);
  });

  test("renderToolList renders every catalog entry", () => {
    const list = renderToolList();
    for (const t of TOOL_CATALOG) {
      expect(list).toContain(t.name);
      expect(list).toContain(t.summary);
    }
  });

  test("renderToolDocs (CLAUDE.md block) lists every tool + structural routing", () => {
    const docs = renderToolDocs();
    for (const t of ALL_TOOLS) expect(docs).toContain(t);
    // routing must explicitly name the structural triggers
    expect(docs.toLowerCase()).toContain("blast");
    expect(docs).toContain("find_symbol");
  });
});
