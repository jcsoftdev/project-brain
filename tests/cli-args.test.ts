import { describe, it, expect } from "bun:test";
import { parsePort, parseModelRoutingFlag } from "../src/cli-args.js";

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
