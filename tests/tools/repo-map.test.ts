import { describe, it, expect } from "bun:test";
import { handleRepoMap } from "../../src/tools/repo-map.js";
import type { ToolDeps } from "../../src/types.js";

const RANKED = [
  { id: 1, name: "createServer", kind: "function", signature: "(opts) => Server", file: "src/server.ts", start_line: 10, end_line: 40, rank: 0.9 },
  { id: 2, name: "registerSearch", kind: "function", signature: "(server, deps) => void", file: "src/server.ts", start_line: 50, end_line: 60, rank: 0.7 },
  { id: 3, name: "GraphStore", kind: "class", signature: "class GraphStore", file: "src/graph/store.ts", start_line: 10, end_line: 200, rank: 0.5 },
  { id: 4, name: "pageRank", kind: "method", signature: "(opts?) => RankedSymbol[]", file: "src/graph/store.ts", start_line: 170, end_line: 260, rank: 0.4 },
];

// A larger canned set so even the minimum allowed token_budget (100, per the
// [100, 8000] clamp) still forces truncation — RANKED above totals ~55
// tokens, too small to exercise truncation once clamped up to the floor.
const MANY_RANKED = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  name: `someVeryDescriptiveFunctionName${i}`,
  kind: "function",
  signature: `(argumentOne: string, argumentTwo: number, argumentThree: boolean) => Promise<SomeLongResultType${i}>`,
  file: `src/module${i % 4}/file${i}.ts`,
  start_line: 1,
  end_line: 10,
  rank: 1 - i * 0.01,
}));

describe("repo_map", () => {
  it("success path: returns map grouped by file with correct counts", async () => {
    const deps = {
      store: {} as ToolDeps["store"],
      embeddings: {} as ToolDeps["embeddings"],
      graph: { pageRank: (_opts?: any) => RANKED } as any,
    } as ToolDeps;
    const r = await handleRepoMap({}, deps);
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as any;
    expect(sc.map).toContain("src/server.ts");
    expect(sc.map).toContain("src/graph/store.ts");
    expect(sc.map).toContain("createServer");
    expect(sc.map).toContain("pageRank");
    expect(sc.files).toBe(2);
    expect(sc.symbols).toBe(4);
    expect(sc.truncated).toBe(false);
  });

  it("truncates when the token budget is too small, and counts reflect only included content", async () => {
    const deps = {
      store: {} as ToolDeps["store"],
      embeddings: {} as ToolDeps["embeddings"],
      graph: { pageRank: (_opts?: any) => MANY_RANKED } as any,
    } as ToolDeps;
    const r = await handleRepoMap({ token_budget: 100 }, deps);
    const sc = r.structuredContent as any;
    expect(sc.truncated).toBe(true);
    expect(sc.symbols).toBeLessThan(MANY_RANKED.length);
  });

  it("returns GRAPH_UNAVAILABLE when deps.graph is missing", async () => {
    const deps = {
      store: {} as ToolDeps["store"],
      embeddings: {} as ToolDeps["embeddings"],
    } as ToolDeps;
    const r = await handleRepoMap({}, deps);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).code).toBe("GRAPH_UNAVAILABLE");
  });

  it("passes the focus array through to graph.pageRank", async () => {
    let receivedOpts: any = null;
    const deps = {
      store: {} as ToolDeps["store"],
      embeddings: {} as ToolDeps["embeddings"],
      graph: {
        pageRank: (opts?: any) => {
          receivedOpts = opts;
          return RANKED;
        },
      } as any,
    } as ToolDeps;
    await handleRepoMap({ focus: ["createServer"] }, deps);
    expect(receivedOpts).toEqual({ focus: ["createServer"] });
  });

  // --- regression guards (added post-review; assert current correct behavior) ---

  function depsWith(ranked: any[]): ToolDeps {
    return {
      store: {} as ToolDeps["store"],
      embeddings: {} as ToolDeps["embeddings"],
      graph: { pageRank: (_opts?: any) => ranked } as any,
    } as ToolDeps;
  }

  /** Split a rendered map into header lines (file paths) and indented symbol lines. */
  function parseMap(map: string): { headers: string[]; symbolLines: string[] } {
    const lines = map === "" ? [] : map.split("\n");
    return {
      headers: lines.filter((l) => !l.startsWith("  ")),
      symbolLines: lines.filter((l) => l.startsWith("  ")),
    };
  }

  it("never emits an orphan file header (every header has >=1 symbol under it)", async () => {
    const r = await handleRepoMap({ token_budget: 100 }, depsWith(MANY_RANKED));
    const sc = r.structuredContent as any;
    expect(sc.truncated).toBe(true); // sanity: this budget really cuts mid-set
    const lines = (sc.map as string).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("  ")) {
        // file header — the NEXT line must exist and be an indented symbol line
        expect(lines[i + 1], `orphan header: ${lines[i]}`).toBeDefined();
        expect(lines[i + 1]!.startsWith("  "), `orphan header: ${lines[i]}`).toBe(true);
      }
    }
  });

  it("rendered map line counts match files/symbols counts (truncated and non-truncated)", async () => {
    const full = (await handleRepoMap({}, depsWith(RANKED))).structuredContent as any;
    expect(full.truncated).toBe(false);
    let parsed = parseMap(full.map);
    expect(parsed.headers.length).toBe(full.files);
    expect(parsed.symbolLines.length).toBe(full.symbols);

    const cut = (await handleRepoMap({ token_budget: 100 }, depsWith(MANY_RANKED))).structuredContent as any;
    expect(cut.truncated).toBe(true);
    parsed = parseMap(cut.map);
    expect(parsed.headers.length).toBe(cut.files);
    expect(parsed.symbolLines.length).toBe(cut.symbols);
  });

  it("accepts clamp boundaries (100, 8000) and treats below-min identically to 100", async () => {
    const atMin = (await handleRepoMap({ token_budget: 100 }, depsWith(MANY_RANKED))).structuredContent;
    const atMax = (await handleRepoMap({ token_budget: 8000 }, depsWith(MANY_RANKED))).structuredContent as any;
    const belowMin = (await handleRepoMap({ token_budget: 1 }, depsWith(MANY_RANKED))).structuredContent;

    // 8000 comfortably fits the whole stubbed set — nothing truncated.
    expect(atMax.truncated).toBe(false);
    expect(atMax.symbols).toBe(MANY_RANKED.length);
    // 1 clamps up to the 100 floor → byte-identical result to an explicit 100.
    expect(belowMin).toEqual(atMin);
  });

  it("empty graph at handler level: empty map, zero counts, not truncated", async () => {
    const r = await handleRepoMap({}, depsWith([]));
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as any;
    expect(sc.map).toBe("");
    expect(sc.files).toBe(0);
    expect(sc.symbols).toBe(0);
    expect(sc.truncated).toBe(false);
  });
});
