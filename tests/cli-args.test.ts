import { describe, it, expect } from "bun:test";
import {
  parsePort,
  parseRoutingHookFlag,
  collectPositionals,
  parseIntFlag,
  parseListFlag,
  parseWorktreeHookFlag,
  parseRecordConnectionFlag,
} from "../src/cli-args.js";

describe("parsePort", () => {
  it("returns the value after --port when present", () => {
    expect(parsePort(["--http", "--port", "4321"], {})).toBe(4321);
  });

  it("falls back to BRAIN_HTTP_PORT env var when --port is absent", () => {
    expect(parsePort(["--http"], { BRAIN_HTTP_PORT: "5555" })).toBe(5555);
  });

  it("falls back to 3000 when neither --port nor env var is set", () => {
    expect(parsePort(["--http"], {})).toBe(3000);
  });

  it("does NOT parse the next flag as a port when --port is absent (regression)", () => {
    // Documented default invocation: `project-brain serve --http` (no --port).
    // Bug: args[args.indexOf("--port") + 1] === args[0] === "--http" when
    // --port is missing (indexOf returns -1, -1+1=0), producing NaN.
    const port = parsePort(["--http"], {});
    expect(Number.isNaN(port)).toBe(false);
    expect(port).toBe(3000);
  });

  it("falls through to default when --port is the last argument with no value", () => {
    expect(parsePort(["--http", "--port"], {})).toBe(3000);
  });
});

describe("parseRoutingHookFlag", () => {
  it("defaults to enforcement off", () => {
    expect(parseRoutingHookFlag([])).toEqual({ strict: false });
  });

  it("resolves enforcement off on --routing-hook", () => {
    expect(parseRoutingHookFlag(["--routing-hook"])).toEqual({ strict: false });
  });

  it("resolves enforcement off on --no-routing-hook", () => {
    expect(parseRoutingHookFlag(["--no-routing-hook"])).toEqual({ strict: false });
  });

  it("turns on strict enforcement on --routing-hook-strict", () => {
    expect(parseRoutingHookFlag(["--routing-hook-strict"])).toEqual({ strict: true });
  });

  it("lets an explicit opt-out win over strict", () => {
    // Contradictory flags resolve to the SAFE reading: enforce nothing.
    expect(parseRoutingHookFlag(["--routing-hook-strict", "--no-routing-hook"])).toEqual({
      strict: false,
    });
  });
});

describe("collectPositionals", () => {
  it("returns positional args, skipping a valued flag and its following value", () => {
    expect(collectPositionals(["foo", "--max-depth", "5"], ["--max-depth"])).toEqual(["foo"]);
  });

  it("returns multiple positionals in order when no flags are present", () => {
    expect(collectPositionals(["from", "to"], ["--max-depth"])).toEqual(["from", "to"]);
  });

  it("skips multiple different valued flags and their values", () => {
    expect(
      collectPositionals(
        ["query", "--limit", "5", "--budget", "200"],
        ["--limit", "--budget"]
      )
    ).toEqual(["query"]);
  });

  it("treats an unlisted flag as non-positional but does NOT consume the next token as its value", () => {
    // Only flags in valuedFlags consume a following value; unknown flags are
    // simply excluded from positionals themselves (not treated as valued).
    expect(collectPositionals(["foo", "--verbose", "bar"], [])).toEqual(["foo", "bar"]);
  });

  it("returns an empty array when there are no positionals", () => {
    expect(collectPositionals(["--max-depth", "5"], ["--max-depth"])).toEqual([]);
  });

  it("handles a valued flag with no following value gracefully (does not throw)", () => {
    expect(collectPositionals(["foo", "--max-depth"], ["--max-depth"])).toEqual(["foo"]);
  });
});

describe("parseIntFlag", () => {
  it("returns the parsed value when the flag is present and valid", () => {
    expect(parseIntFlag(["--max-depth", "5"], "--max-depth", { def: 6, min: 1, max: 20 })).toBe(5);
  });

  it("clamps to max when the value exceeds the max", () => {
    expect(parseIntFlag(["--max-depth", "100"], "--max-depth", { def: 6, min: 1, max: 20 })).toBe(20);
  });

  it("clamps to min when the value is below the min", () => {
    expect(parseIntFlag(["--max-depth", "0"], "--max-depth", { def: 6, min: 1, max: 20 })).toBe(1);
  });

  it("falls back to def when the flag is absent", () => {
    expect(parseIntFlag([], "--max-depth", { def: 6, min: 1, max: 20 })).toBe(6);
  });

  it("falls back to def when the value is not a valid integer", () => {
    expect(parseIntFlag(["--max-depth", "abc"], "--max-depth", { def: 6, min: 1, max: 20 })).toBe(6);
  });

  it("falls back to def when the flag is the last argument with no value", () => {
    expect(parseIntFlag(["--max-depth"], "--max-depth", { def: 6, min: 1, max: 20 })).toBe(6);
  });
});

describe("parseListFlag", () => {
  it("comma-splits and trims the flag's value", () => {
    expect(parseListFlag(["--focus", "a, b ,c"], "--focus")).toEqual(["a", "b", "c"]);
  });

  it("drops empty entries produced by consecutive commas", () => {
    expect(parseListFlag(["--focus", "a,,b"], "--focus")).toEqual(["a", "b"]);
  });

  it("returns undefined when the flag is absent", () => {
    expect(parseListFlag([], "--focus")).toBeUndefined();
  });

  it("returns undefined when the flag is the last argument with no value", () => {
    expect(parseListFlag(["--focus"], "--focus")).toBeUndefined();
  });
});

describe("parseWorktreeHookFlag", () => {
  it("defaults to no guard", () => {
    expect(parseWorktreeHookFlag([])).toEqual({ strict: false });
  });

  it("resolves enforcement off on --no-worktree-hook", () => {
    expect(parseWorktreeHookFlag(["--no-worktree-hook"])).toEqual({ strict: false });
  });

  it("turns on strict enforcement on --worktree-hook-strict", () => {
    expect(parseWorktreeHookFlag(["--worktree-hook-strict"])).toEqual({ strict: true });
  });

  it("resolves contradictory flags to the reading that enforces nothing", () => {
    expect(
      parseWorktreeHookFlag(["--worktree-hook-strict", "--no-worktree-hook"])
    ).toEqual({ strict: false });
  });
});

describe("parseRecordConnectionFlag", () => {
  it('defaults to "fresh" on CDP port 9222', () => {
    expect(parseRecordConnectionFlag([])).toEqual({ mode: "fresh", cdpPort: 9222 });
  });

  it("switches to live only on the explicit flag", () => {
    expect(parseRecordConnectionFlag(["--record-connection-live"])).toEqual({
      mode: "live",
      cdpPort: 9222,
    });
  });

  it("reads a custom CDP port independently of the mode", () => {
    expect(parseRecordConnectionFlag(["--record-cdp-port", "9333"])).toEqual({
      mode: "fresh",
      cdpPort: 9333,
    });
    expect(
      parseRecordConnectionFlag(["--record-connection-live", "--record-cdp-port", "9333"])
    ).toEqual({ mode: "live", cdpPort: 9333 });
  });

  it("falls back to the default port on a garbage value", () => {
    expect(parseRecordConnectionFlag(["--record-cdp-port", "not-a-number"])).toEqual({
      mode: "fresh",
      cdpPort: 9222,
    });
  });
});

describe("parseUnitFlags", () => {
  const ALL = [
    "host:claudecode",
    "guidance:model-routing",
    "hooks:routing",
    "hooks:worktree",
    "skill:brain-audit",
    "skill:brain-okf",
    "embed:ollama-model",
  ];

  it("reports default mode when no selection flag is present", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    expect(parseUnitFlags([], ALL)).toEqual({ mode: "default", selected: [] });
  });

  it("selects everything with --all and nothing with --none", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    expect(parseUnitFlags(["--all"], ALL)).toEqual({ mode: "explicit", selected: ALL });
    expect(parseUnitFlags(["--none"], ALL)).toEqual({ mode: "explicit", selected: [] });
  });

  it("--without starts from everything and subtracts", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    const result = parseUnitFlags(["--without=skill:brain-okf"], ALL);
    expect(result).toEqual({
      mode: "explicit",
      selected: ALL.filter((id) => id !== "skill:brain-okf"),
    });
  });

  it("--with starts from nothing and adds", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    expect(parseUnitFlags(["--with=skill:brain-audit,hooks:routing"], ALL)).toEqual({
      mode: "explicit",
      selected: ["hooks:routing", "skill:brain-audit"],
    });
  });

  it("expands the group wildcard used by the legacy skill flags", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    expect(parseUnitFlags(["--with=skill:*"], ALL)).toEqual({
      mode: "explicit",
      selected: ["skill:brain-audit", "skill:brain-okf"],
    });
  });

  it("maps every legacy flag onto the new ids", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");

    expect(parseUnitFlags(["--no-skills"], ALL).selected).not.toContain("skill:brain-audit");
    expect(parseUnitFlags(["--no-brain-audit"], ALL).selected).not.toContain("skill:brain-okf");
    expect(parseUnitFlags(["--no-model-routing"], ALL).selected).not.toContain(
      "guidance:model-routing"
    );
    expect(parseUnitFlags(["--no-routing-hook"], ALL).selected).not.toContain("hooks:routing");
    expect(parseUnitFlags(["--no-worktree-hook"], ALL).selected).not.toContain("hooks:worktree");
  });

  it("rejects an unknown id instead of silently ignoring it", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    const result = parseUnitFlags(["--with=skill:brain-typo"], ALL) as { error: string };

    expect(result.error).toContain("skill:brain-typo");
    expect(result.error).toContain("skill:brain-audit");
  });

  it("treats --with= with an empty value as an explicit empty selection", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    expect(parseUnitFlags(["--with="], ALL)).toEqual({
      mode: "explicit",
      selected: [],
    });
  });

  it("treats --without= with an empty value as an explicit full selection (subtract nothing)", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    expect(parseUnitFlags(["--without="], ALL)).toEqual({
      mode: "explicit",
      selected: ALL,
    });
  });

  it("rejects a bare --with (no =) as malformed syntax", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    const result = parseUnitFlags(["--with"], ALL) as { error: string };

    expect(result.error).toContain("--with=");
    expect(result.error).toContain("skill:brain-audit,hooks:routing");
  });

  it("rejects a bare --without (no =) as malformed syntax", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    const result = parseUnitFlags(["--without"], ALL) as { error: string };

    expect(result.error).toContain("--without=");
  });

  it("rejects a wildcard pattern that matches zero units", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    const result = parseUnitFlags(["--with=totallywrong:*"], ALL) as { error: string };

    expect(result.error).toContain("totallywrong:*");
    expect(result.error).toContain("skill:");
    expect(result.error).toContain("host:");
  });

  it("resolves --no-skills --with=skill:brain-audit with subtraction winning (skill NOT selected)", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    const result = parseUnitFlags(["--no-skills", "--with=skill:brain-audit"], ALL);

    expect(result.mode).toBe("explicit");
    expect(result.selected).not.toContain("skill:brain-audit");
  });

  it("resolves --all --none with --none winning (empty selection)", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    expect(parseUnitFlags(["--all", "--none"], ALL)).toEqual({
      mode: "explicit",
      selected: [],
    });
  });

  it("accumulates ids from repeated --with= occurrences (guards against silent dropping)", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    expect(parseUnitFlags(["--with=skill:brain-audit", "--with=hooks:routing"], ALL)).toEqual({
      mode: "explicit",
      selected: ["hooks:routing", "skill:brain-audit"],
    });
  });

  it("accumulates ids from repeated --without= occurrences", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    const result = parseUnitFlags(["--without=skill:brain-audit", "--without=hooks:routing"], ALL);

    expect(result.mode).toBe("explicit");
    expect(result.selected).not.toContain("skill:brain-audit");
    expect(result.selected).not.toContain("hooks:routing");
  });

  it("rejects a bare --with appearing alongside a well-formed --with=...", async () => {
    const { parseUnitFlags } = await import("../src/cli-args.js");
    const result = parseUnitFlags(["--with", "--with=skill:brain-audit"], ALL) as {
      error: string;
    };

    expect(result.error).toContain("--with=");
  });
});
