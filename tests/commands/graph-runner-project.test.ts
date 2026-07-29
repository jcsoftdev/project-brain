/**
 * The MCP structural tools can target another indexed project by id. Without
 * the same option on the CLI, the project registry is only reachable from
 * inside an assistant session — `project-brain map --project other` would
 * silently map the CURRENT directory instead.
 */
import { describe, it, expect } from "bun:test";
import { withGraph } from "../../src/commands/graph-runner.js";
import { parseStringFlag } from "../../src/cli-args.js";
import type { GraphStore } from "../../src/graph/store.js";

function stubGraph(symbolCount = 3): GraphStore {
  return {
    countSymbols: () => symbolCount,
    close: () => {},
  } as unknown as GraphStore;
}

describe("parseStringFlag", () => {
  it("reads the value after the flag", () => {
    expect(parseStringFlag(["map", "--project", "other"], "--project")).toBe("other");
  });

  it("returns undefined when the flag is absent", () => {
    expect(parseStringFlag(["map"], "--project")).toBeUndefined();
  });

  it("returns undefined when the flag has no value", () => {
    expect(parseStringFlag(["map", "--project"], "--project")).toBeUndefined();
  });

  it("does not treat the next flag as the value", () => {
    expect(parseStringFlag(["map", "--project", "--budget", "500"], "--project")).toBeUndefined();
  });
});

describe("withGraph --project", () => {
  it("resolves the root through the registry instead of the cwd walk", async () => {
    const opened: string[] = [];
    let walkedCwd = false;

    await withGraph(async () => "ok", {
      project: "other-proj",
      lookupRoot: async (id) => (id === "other-proj" ? "/registered/root" : null),
      findRoot: () => { walkedCwd = true; return "/cwd/root"; },
      openGraph: (root) => { opened.push(root); return stubGraph(); },
      exit: () => {},
      log: () => {},
      error: () => {},
    });

    expect(opened).toEqual(["/registered/root"]);
    expect(walkedCwd).toBe(false);
  });

  it("still walks up from the cwd when no project is given", async () => {
    const opened: string[] = [];

    await withGraph(async () => "ok", {
      findRoot: () => "/cwd/root",
      lookupRoot: async () => { throw new Error("should not be called"); },
      openGraph: (root) => { opened.push(root); return stubGraph(); },
      exit: () => {},
      log: () => {},
      error: () => {},
    });

    expect(opened).toEqual(["/cwd/root"]);
  });

  it("exits 1 naming the project when it is not registered", async () => {
    const errors: string[] = [];
    const codes: number[] = [];
    let fnCalled = false;

    await withGraph(async () => { fnCalled = true; return "x"; }, {
      project: "ghost",
      lookupRoot: async () => null,
      openGraph: () => { throw new Error("should not be called"); },
      exit: (code) => { codes.push(code); },
      log: () => {},
      error: (msg) => { errors.push(msg); },
    });

    expect(fnCalled).toBe(false);
    expect(codes).toEqual([1]);
    expect(errors.join(" ")).toContain("ghost");
  });
});
