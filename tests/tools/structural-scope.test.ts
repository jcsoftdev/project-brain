/**
 * Every structural tool must (a) say which project it answered for, and
 * (b) accept an explicit `project` to target another indexed repository.
 * Before this, they silently answered from whichever root their server process
 * was started in.
 */
import { describe, it, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { handleFindSymbol } from "../../src/tools/find-symbol.js";
import { handleFindCallers, handleFindCallees } from "../../src/tools/callgraph.js";
import { handleImpact } from "../../src/tools/impact.js";
import { handleTracePath } from "../../src/tools/trace-path.js";
import { handleRepoMap } from "../../src/tools/repo-map.js";
import type { GraphDeps } from "../../src/types.js";

/** caller() → callee() in one file, so callers/callees/impact/trace all resolve. */
function makeGraph(file: string, caller: string, callee: string): GraphStore {
  const g = new GraphStore(openGraphDb(":memory:"));
  g.replaceFile(file, "typescript", "h", 1, [
    {
      name: caller, kind: "function", signature: `fn ${caller}`,
      start_line: 1, end_line: 5, edges: [{ dst_name: callee, edge_type: "call" }],
    },
    { name: callee, kind: "function", signature: `fn ${callee}`, start_line: 7, end_line: 9, edges: [] },
  ]);
  g.resolveEdgesForFile(file);
  return g;
}

function ownDeps(): { deps: GraphDeps; close: () => void } {
  const own = makeGraph("own.ts", "ownCaller", "ownCallee");
  const other = makeGraph("other.ts", "otherCaller", "otherCallee");
  return {
    deps: {
      graph: own,
      projectId: "mine",
      graphFor: async (p) => (p === "theirs" ? other : null),
    },
    close: () => { own.close(); other.close(); },
  };
}

const invocations: Array<[string, (deps: GraphDeps, project?: string) => Promise<any>]> = [
  ["find_symbol", (d, project) => handleFindSymbol({ name: "ownCallee", project }, d)],
  ["find_callers", (d, project) => handleFindCallers({ name: "ownCallee", project }, d)],
  ["find_callees", (d, project) => handleFindCallees({ name: "ownCaller", project }, d)],
  ["impact", (d, project) => handleImpact({ name: "ownCallee", project }, d)],
  ["trace_path", (d, project) => handleTracePath({ from: "ownCaller", to: "ownCallee", project }, d)],
  ["repo_map", (d, project) => handleRepoMap({ project }, d)],
];

describe("structural tools report the project they answered for", () => {
  for (const [name, invoke] of invocations) {
    it(`${name} echoes the served project id`, async () => {
      const { deps, close } = ownDeps();
      const res = await invoke(deps, undefined);
      expect(res.structuredContent?.project, `${name} did not echo project`).toBe("mine");
      close();
    });
  }
});

describe("structural tools accept an explicit project", () => {
  it("find_symbol reads the targeted project's graph", async () => {
    const { deps, close } = ownDeps();
    const res = await handleFindSymbol({ name: "otherCallee", project: "theirs" }, deps);
    expect(res.structuredContent?.project).toBe("theirs");
    expect((res.structuredContent?.hits as any[])[0].path).toBe("other.ts");
    close();
  });

  it("repo_map ranks the targeted project's symbols", async () => {
    const { deps, close } = ownDeps();
    const res = await handleRepoMap({ project: "theirs" }, deps);
    expect(res.structuredContent?.project).toBe("theirs");
    expect(String(res.structuredContent?.map)).toContain("other.ts");
    close();
  });

  it("a symbol from the OTHER project is not found in the served one", async () => {
    const { deps, close } = ownDeps();
    const res = await handleFindSymbol({ name: "otherCallee" }, deps);
    expect(res.structuredContent?.hits).toEqual([]);
    close();
  });

  for (const [name, invoke] of invocations) {
    it(`${name} errors with PROJECT_NOT_FOUND for an unregistered project`, async () => {
      const { deps, close } = ownDeps();
      const res = await invoke(deps, "ghost");
      expect(res.isError, `${name} did not error`).toBe(true);
      expect(res.structuredContent?.code).toBe("PROJECT_NOT_FOUND");
      close();
    });
  }
});
