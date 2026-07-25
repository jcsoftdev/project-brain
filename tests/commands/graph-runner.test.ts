import { describe, it, expect } from "bun:test";
import { withGraph } from "../../src/commands/graph-runner.js";
import type { GraphStore } from "../../src/graph/store.js";

function makeStubGraph(symbolCount: number): { graph: GraphStore; closed: boolean[] } {
  const closed: boolean[] = [];
  const graph = {
    countSymbols: () => symbolCount,
    close: () => { closed.push(true); },
  } as unknown as GraphStore;
  return { graph, closed };
}

describe("withGraph", () => {
  it("errors and exits 1 when no project root is found, without calling fn", async () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];
    let fnCalled = false;

    await withGraph(
      async () => { fnCalled = true; return "unreachable"; },
      {
        findRoot: () => null,
        openGraph: () => { throw new Error("should not be called"); },
        exit: (code) => { exitCodes.push(code); },
        error: (msg) => { errors.push(msg); },
        log: () => {},
      }
    );

    expect(fnCalled).toBe(false);
    expect(exitCodes).toEqual([1]);
    expect(errors[0]).toContain("Not a project-brain project");
    expect(errors[0]).toContain("project-brain init");
  });

  it("errors and exits 1 when no graph.db exists yet, without calling fn", async () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];
    let fnCalled = false;

    await withGraph(
      async () => { fnCalled = true; return "unreachable"; },
      {
        findRoot: () => "/fake/root",
        openGraph: () => null,
        exit: (code) => { exitCodes.push(code); },
        error: (msg) => { errors.push(msg); },
        log: () => {},
      }
    );

    expect(fnCalled).toBe(false);
    expect(exitCodes).toEqual([1]);
    expect(errors[0]).toContain("No structural index yet");
    expect(errors[0]).toContain("project-brain sync");
  });

  it("errors and exits 1 when the graph is empty, closes the handle, without calling fn", async () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];
    let fnCalled = false;
    const { graph, closed } = makeStubGraph(0);

    await withGraph(
      async () => { fnCalled = true; return "unreachable"; },
      {
        findRoot: () => "/fake/root",
        openGraph: () => graph,
        exit: (code) => { exitCodes.push(code); },
        error: (msg) => { errors.push(msg); },
        log: () => {},
      }
    );

    expect(fnCalled).toBe(false);
    expect(exitCodes).toEqual([1]);
    expect(errors[0]).toContain("Structural index is empty");
    expect(errors[0]).toContain("project-brain sync");
    expect(closed).toEqual([true]);
  });

  it("calls fn with the graph, logs its result, and closes the handle on success", async () => {
    const logs: string[] = [];
    const { graph, closed } = makeStubGraph(3);
    let receivedGraph: GraphStore | undefined;

    await withGraph(
      async (g) => { receivedGraph = g; return "hello world"; },
      {
        findRoot: () => "/fake/root",
        openGraph: () => graph,
        exit: () => { throw new Error("should not exit on success"); },
        error: () => {},
        log: (msg) => { logs.push(msg); },
      }
    );

    expect(receivedGraph).toBe(graph);
    expect(logs).toEqual(["hello world"]);
    expect(closed).toEqual([true]);
  });

  it("still closes the handle when fn throws", async () => {
    const { graph, closed } = makeStubGraph(3);

    await expect(
      withGraph(
        async () => { throw new Error("boom"); },
        {
          findRoot: () => "/fake/root",
          openGraph: () => graph,
          exit: () => {},
          error: () => {},
          log: () => {},
        }
      )
    ).rejects.toThrow("boom");

    expect(closed).toEqual([true]);
  });
});
