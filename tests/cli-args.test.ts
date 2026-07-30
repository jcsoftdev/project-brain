import { describe, it, expect } from "bun:test";
import {
  parsePort,
  parseModelRoutingFlag,
  parseSkillInstallFlag,
  collectPositionals,
  parseIntFlag,
  parseListFlag,
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

describe("parseModelRoutingFlag", () => {
  it('returns "yes" when --model-routing is present', () => {
    expect(parseModelRoutingFlag(["--model-routing"])).toBe("yes");
  });

  it('returns "no" when --no-model-routing is present', () => {
    expect(parseModelRoutingFlag(["--no-model-routing"])).toBe("no");
  });

  it('returns "ask" when neither flag is present', () => {
    expect(parseModelRoutingFlag([])).toBe("ask");
  });

  it('returns "yes" when both flags are present (--model-routing checked first)', () => {
    expect(parseModelRoutingFlag(["--model-routing", "--no-model-routing"])).toBe("yes");
  });
});

describe("parseSkillInstallFlag", () => {
  it('returns "yes" for --brain-audit', () => {
    expect(parseSkillInstallFlag(["setup", "--brain-audit"])).toBe("yes");
  });

  it('returns "no" for --no-brain-audit', () => {
    expect(parseSkillInstallFlag(["setup", "--no-brain-audit"])).toBe("no");
  });

  it('returns "ask" when neither flag is present', () => {
    expect(parseSkillInstallFlag(["setup"])).toBe("ask");
  });

  it('returns "yes" when both are passed (--brain-audit checked first)', () => {
    expect(parseSkillInstallFlag(["setup", "--brain-audit", "--no-brain-audit"])).toBe("yes");
  });

  /** Exact match only — --no-brain-audit must not be read as --brain-audit. */
  it('does not read --no-brain-audit as a bare --brain-audit', () => {
    expect(parseSkillInstallFlag(["--no-brain-audit"])).toBe("no");
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
