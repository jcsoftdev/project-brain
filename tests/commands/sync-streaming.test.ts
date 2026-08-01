/**
 * runSync used to materialize a whole run before storing any of it: every
 * changed file's content, every chunk's text, every reused vector, every
 * embedded vector and every unchanged chunk fetched back from the store were
 * all live at the same time, released only when the function returned.
 *
 * Short-lived CLI runs did not care. The MCP `sync_project` tool does: it
 * passes `changedFiles: []` (a full walk) and runs INSIDE the long-lived serve
 * process, so a cold repo's peak became that process's resident high-water
 * mark for the rest of its life. Measured on the author's machine: a server
 * 19 minutes old held 260MB while one idle for 5 days held 58MB — the cost
 * tracked work done, never uptime.
 *
 * The fix processes files in bounded windows. These tests pin the property
 * that makes it a fix — work is stored before the run is finished — rather
 * than measuring memory, which no assertion can do reliably.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

/** Records the interleaving of embed and store calls — the whole point here. */
function makeTracingStore() {
  const data = new Map<string, Chunk[]>();
  const trace = {
    /** Texts embedded by the time the FIRST batchReplace landed. */
    embeddedAtFirstStore: -1,
    storeCalls: 0,
    /** Largest single id list handed to getChunksByIds. */
    maxIdLookup: 0,
    embedded: 0,
  };
  const store: VectorStore = {
    ensureTable: async () => {},
    upsert: async () => {},
    search: async (): Promise<SearchResult[]> => [],
    deleteBySource: async (project, source) => {
      const existing = data.get(project) ?? [];
      data.set(project, existing.filter((c) => c.source !== source));
    },
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async (project) => (data.get(project) ?? []).length,
    optimize: async () => {},
    batchReplace: async (project, sources, chunks) => {
      if (trace.embeddedAtFirstStore === -1) trace.embeddedAtFirstStore = trace.embedded;
      trace.storeCalls++;
      const existing = (data.get(project) ?? []).filter((c) => !sources.includes(c.source));
      data.set(project, [...existing, ...chunks]);
    },
    buildIndexes: async () => {},
    hybridSearch: async (): Promise<SearchResult[]> => [],
    getChunkById: async () => null,
    getChunksByIds: async (_project, ids) => {
      trace.maxIdLookup = Math.max(trace.maxIdLookup, ids.length);
      return new Map();
    },
    assertDim: async () => {},
  };
  return { store, data, trace };
}

function makeTracingEmbeddings(trace: { embedded: number }): EmbeddingClient {
  return {
    dim: VECTOR_DIM,
    model: "test-model",
    embed: async (texts) => {
      trace.embedded += texts.length;
      return texts.map(() => new Array(VECTOR_DIM).fill(0.1));
    },
    isAvailable: async () => true,
  };
}

const FILE_COUNT = 60;

async function seedProject(root: string, count = FILE_COUNT): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  for (let i = 0; i < count; i++) {
    await writeFile(
      join(root, "src", `mod${i}.ts`),
      `export function fn${i}(a: number, b: number): number {\n  return a + b;\n}\n`
    );
  }
}

describe("runSync — bounded windows", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-stream-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * The defining difference. Before: ZERO chunks were stored until the LAST
   * chunk of the run had been embedded, so everything in between had to stay
   * in memory. After: the first window is durable long before the run ends.
   */
  it("stores the first window before the run is fully embedded", async () => {
    const { runSync } = await import("../../src/commands/sync.js");
    const { store, trace } = makeTracingStore();
    await seedProject(tempDir);

    const result = await runSync({
      root: tempDir,
      projectId: "stream",
      store,
      embeddings: makeTracingEmbeddings(trace),
      windowFiles: 10,
    });

    expect(result.ingested).toBe(FILE_COUNT);
    expect(trace.embedded).toBeGreaterThan(0);
    expect(trace.storeCalls).toBeGreaterThan(1);
    expect(
      trace.embeddedAtFirstStore,
      "nothing was stored until the entire run had been embedded — the whole run was live at once"
    ).toBeLessThan(trace.embedded);
  });

  /**
   * Window size must actually govern the peak. Doubling the file count with
   * the same window must NOT increase how much is in flight — that is what
   * makes the memory bound independent of repo size.
   */
  it("keeps the in-flight slice flat as the repo grows", async () => {
    const { runSync } = await import("../../src/commands/sync.js");

    async function peakFor(count: number): Promise<number> {
      const root = await mkdtemp(join(tmpdir(), "brain-stream-peak-"));
      try {
        const { store, trace } = makeTracingStore();
        await seedProject(root, count);
        await runSync({
          root,
          projectId: "peak",
          store,
          embeddings: makeTracingEmbeddings(trace),
          windowFiles: 10,
        });
        return trace.embeddedAtFirstStore;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    const small = await peakFor(20);
    const large = await peakFor(80);

    expect(small).toBeGreaterThan(0);
    expect(
      large,
      "in-flight work grew with the repo — the window is not bounding anything"
    ).toBeLessThanOrEqual(small * 2);
  });

  /**
   * Windowing must not change the outcome. Every file indexed, every chunk
   * stored, identical to running with a window larger than the whole repo.
   */
  it("produces the same index as an unwindowed run", async () => {
    const { runSync } = await import("../../src/commands/sync.js");

    async function indexWith(windowFiles: number) {
      const root = await mkdtemp(join(tmpdir(), "brain-stream-parity-"));
      try {
        const { store, data, trace } = makeTracingStore();
        await seedProject(root, 30);
        const result = await runSync({
          root,
          projectId: "parity",
          store,
          embeddings: makeTracingEmbeddings(trace),
          windowFiles,
        });
        const chunks = (data.get("parity") ?? [])
          .map((c) => `${c.source}#${c.content_hash}`)
          .sort();
        return { result, chunks };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    const windowed = await indexWith(7);
    const whole = await indexWith(10_000);

    expect(windowed.result.ingested).toBe(whole.result.ingested);
    expect(windowed.result.skipped).toBe(whole.result.skipped);
    expect(windowed.result.embedFailed).toBe(whole.result.embedFailed);
    expect(windowed.chunks, "windowing changed what ends up indexed").toEqual(whole.chunks);
  });

  /**
   * A caller in an EARLY window referencing a symbol defined in a LATER one.
   *
   * `impact` is the assertion, not `findCallers`: findCallers matches on
   * `edges.dst_name` and never reads `dst_symbol_id`, so it answers correctly
   * whether or not the edge was ever linked and cannot detect this at all.
   * `impact` walks `e.dst_symbol_id = up.id`, so it only reaches callerFn if
   * the link was actually made.
   *
   * Ordering is explicit via `changedFiles` rather than relying on the walk:
   * listAllFiles returns readdir order, which is not sorted on every
   * filesystem, so a fixture that assumes alphabetical placement could put
   * both files in the same window and quietly assert nothing.
   *
   * Honest about what this does and does not pin: it guards the OUTCOME
   * (cross-window edges are traversable), not the placement of
   * resolveEdgesForFiles. Mutation showed the outcome survives resolving per
   * window even with pruneDanglingEdges disabled, because resolveEdgesForFile
   * also re-links edges pointing INTO the file it is given. Placement is a
   * transaction-count decision; this test would catch losing the link
   * altogether.
   */
  it("links call edges across a window boundary", async () => {
    const { runSync } = await import("../../src/commands/sync.js");
    const { openGraphDb } = await import("../../src/graph/db.js");
    const { GraphStore } = await import("../../src/graph/store.js");
    const { store, trace } = makeTracingStore();

    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "caller.ts"),
      `export function callerFn(): number {\n  return calleeFn();\n}\n`
    );
    const padding: string[] = [];
    for (let i = 0; i < 8; i++) {
      const rel = `src/pad${i}.ts`;
      await writeFile(join(tempDir, rel), `export function pad${i}(): number {\n  return ${i};\n}\n`);
      padding.push(rel);
    }
    await writeFile(
      join(tempDir, "src", "callee.ts"),
      `export function calleeFn(): number {\n  return 42;\n}\n`
    );

    await runSync({
      root: tempDir,
      projectId: "edges",
      store,
      embeddings: makeTracingEmbeddings(trace),
      windowFiles: 2,
      // Caller first, callee last — guaranteed different windows.
      changedFiles: ["src/caller.ts", ...padding, "src/callee.ts"],
    });

    const graph = new GraphStore(openGraphDb(join(tempDir, ".project-brain", "graph.db")));
    try {
      expect(
        graph.impact("calleeFn").map((s) => s.name),
        "the edge into a later window was never linked — impact cannot traverse it"
      ).toContain("callerFn");
    } finally {
      graph.close();
    }
  });

  /**
   * Failed chunks are reported by source across the whole run, not just the
   * last window — the per-window arrays that carry them are released, so the
   * report has to be accumulated as it goes.
   */
  it("reports embed failures from every window, not only the last", async () => {
    const { runSync } = await import("../../src/commands/sync.js");
    const { store, trace } = makeTracingStore();
    await seedProject(tempDir, 24);

    // Fail everything: each window contributes its own failures.
    const alwaysFails: EmbeddingClient = {
      dim: VECTOR_DIM,
      model: "test-model",
      embed: async () => null,
      isAvailable: async () => true,
    };

    const result = await runSync({
      root: tempDir,
      projectId: "failures",
      store,
      embeddings: alwaysFails,
      windowFiles: 6,
      rescueSleeps: async () => {},
    });

    expect(result.embedFailed).toBeGreaterThan(0);
    expect(result.embedFailedSources.length).toBe(result.embedFailed);
    const distinctFiles = new Set(result.embedFailedSources.map((s) => s.split(":")[0]));
    expect(
      distinctFiles.size,
      "only one window's failures were reported — the rest were released with their window"
    ).toBeGreaterThan(6);
    // Total embed failure is a whole-run verdict, not a per-window one.
    expect(result.error, "total embed failure must still be detected across windows").toBeDefined();
  });
});
