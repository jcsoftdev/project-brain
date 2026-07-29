/**
 * The structural tools read a project-LOCAL graph. Without scoping they can
 * only ever answer for the root their server process started in — and they said
 * nothing about which project that was, so a caller pairing
 * `search_context(project: "X")` with `repo_map()` could silently get answers
 * from two different repositories.
 */
import { describe, it, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { resolveGraphScope } from "../../src/tools/graph-scope.js";
import type { GraphDeps } from "../../src/types.js";

function makeGraph(file: string): GraphStore {
  const g = new GraphStore(openGraphDb(":memory:"));
  g.replaceFile(file, "typescript", "h", 1, [
    { name: "x", kind: "function", signature: "fn x", start_line: 1, end_line: 2, edges: [] },
  ]);
  return g;
}

describe("resolveGraphScope", () => {
  it("returns the server's own graph and project when no project is asked for", async () => {
    const own = makeGraph("own.ts");
    const deps: GraphDeps = { graph: own, projectId: "mine" };

    const scope = await resolveGraphScope(deps, undefined);
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.project).toBe("mine");
    expect(scope.graph.listFiles()).toEqual(["own.ts"]);
    own.close();
  });

  it("returns the server's own graph when the asked-for project IS its own", async () => {
    const own = makeGraph("own.ts");
    const deps: GraphDeps = { graph: own, projectId: "mine" };

    const scope = await resolveGraphScope(deps, "mine");
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.graph.listFiles()).toEqual(["own.ts"]);
    own.close();
  });

  it("resolves a DIFFERENT project through graphFor", async () => {
    const own = makeGraph("own.ts");
    const other = makeGraph("other.ts");
    const deps: GraphDeps = {
      graph: own,
      projectId: "mine",
      graphFor: async (p) => (p === "theirs" ? other : null),
    };

    const scope = await resolveGraphScope(deps, "theirs");
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.project).toBe("theirs");
    expect(scope.graph.listFiles()).toEqual(["other.ts"]);
    own.close();
    other.close();
  });

  it("errors with PROJECT_NOT_FOUND when the project cannot be resolved", async () => {
    const own = makeGraph("own.ts");
    const deps: GraphDeps = { graph: own, projectId: "mine", graphFor: async () => null };

    const scope = await resolveGraphScope(deps, "ghost");
    expect(scope.ok).toBe(false);
    if (scope.ok) return;
    expect(scope.result.isError).toBe(true);
    expect(scope.result.structuredContent?.code).toBe("PROJECT_NOT_FOUND");
    // The message must name the project so the caller can tell WHICH id failed.
    expect(String(scope.result.structuredContent?.error)).toContain("ghost");
    own.close();
  });

  it("errors with PROJECT_NOT_FOUND when a foreign project is asked for but no resolver is wired", async () => {
    const own = makeGraph("own.ts");
    const deps: GraphDeps = { graph: own, projectId: "mine" };

    const scope = await resolveGraphScope(deps, "theirs");
    expect(scope.ok).toBe(false);
    if (scope.ok) return;
    expect(scope.result.structuredContent?.code).toBe("PROJECT_NOT_FOUND");
    own.close();
  });

  it("errors with GRAPH_UNAVAILABLE when there is no graph at all", async () => {
    const scope = await resolveGraphScope({}, undefined);
    expect(scope.ok).toBe(false);
    if (scope.ok) return;
    expect(scope.result.structuredContent?.code).toBe("GRAPH_UNAVAILABLE");
  });

  it("falls back to 'unknown' as the reported project when the server has no id", async () => {
    const own = makeGraph("own.ts");
    const scope = await resolveGraphScope({ graph: own }, undefined);
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.project).toBe("unknown");
    own.close();
  });
});
