import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

// ── helpers ────────────────────────────────────────────────────────────────

/** In-memory store that supports getChunkById for vector reuse. */
function makeMemoryStore(): VectorStore & { data: Map<string, Chunk[]> } {
  const data = new Map<string, Chunk[]>();
  return {
    data,
    ensureTable: async () => {},
    upsert: async (project, chunks) => {
      const existing = data.get(project) ?? [];
      for (const chunk of chunks) {
        const idx = existing.findIndex((c) => c.id === chunk.id);
        if (idx >= 0) existing[idx] = chunk;
        else existing.push(chunk);
      }
      data.set(project, existing);
    },
    search: async (): Promise<SearchResult[]> => [],
    deleteBySource: async (project, source) => {
      const existing = data.get(project) ?? [];
      data.set(project, existing.filter((c) => c.source !== source));
    },
    listModules: async (project) => {
      const chunks = data.get(project) ?? [];
      return [...new Set(chunks.map((c) => c.module))].sort();
    },
    getModuleChunks: async (project, module) => {
      const chunks = data.get(project) ?? [];
      return chunks.filter((c) => c.module === module);
    },
    countChunks: async (project) => (data.get(project) ?? []).length,
    optimize: async () => {},
    batchReplace: async (project, sources, chunks) => {
      const existing = (data.get(project) ?? []).filter((c) => !sources.includes(c.source));
      data.set(project, [...existing, ...chunks]);
    },
    buildIndexes: async () => {},
    hybridSearch: async (): Promise<SearchResult[]> => [],
    /** Return the stored chunk by id so sync can reuse its vector. */
    getChunkById: async (project, id) => {
      const chunks = data.get(project) ?? [];
      return chunks.find((c) => c.id === id) ?? null;
    },
    assertDim: async () => {},
  };
}

/** Same as makeMemoryStore but also implements getChunksByIds with a call counter. */
function makeMemoryStoreWithBatchLookup(): VectorStore & { data: Map<string, Chunk[]>; batchCalls: number } {
  const base = makeMemoryStore();
  let batchCalls = 0;
  return {
    ...base,
    get batchCalls() { return batchCalls; },
    getChunksByIds: async (project, ids) => {
      batchCalls++;
      const result = new Map<string, Chunk>();
      const chunks = base.data.get(project) ?? [];
      for (const id of ids) {
        const found = chunks.find((c) => c.id === id);
        if (found) result.set(id, found);
      }
      return result;
    },
  } as VectorStore & { data: Map<string, Chunk[]>; batchCalls: number };
}

/** Spy embedder: tracks every call and which texts were embedded. */
function makeSpyEmbedder() {
  const calls: string[][] = [];
  const client: EmbeddingClient = {
    dim: VECTOR_DIM,
    model: "spy-model",
    embed: async (texts) => {
      calls.push([...texts]);
      // Return distinct vectors so each chunk gets a unique embedding
      return texts.map((_, i) => new Array(VECTOR_DIM).fill(calls.length * 100 + i + 1));
    },
    isAvailable: async () => true,
  };
  return { client, calls };
}

// ── test suite ──────────────────────────────────────────────────────────────

describe("T-8: per-chunk embedding hash", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-chunkhash-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("T-8.1: second sync of unchanged file does not call embedder at all", async () => {
    const store = makeMemoryStore();
    const { client, calls } = makeSpyEmbedder();

    await writeFile(join(tempDir, "doc.md"), "# Section A\n\nContent A.\n\n# Section B\n\nContent B.");

    const { runSync } = await import("../../src/commands/sync.js");

    // First sync — embeds everything
    await runSync({ root: tempDir, projectId: "proj", store, embeddings: client });
    const callsAfterFirst = calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0); // sanity: something was embedded

    // Second sync — content identical, file should be fully skipped (mtime fast-path or hash match)
    await runSync({ root: tempDir, projectId: "proj", store, embeddings: client });
    expect(calls.length).toBe(callsAfterFirst); // no new embed calls
  });

  it("T-8.2: editing ONE chunk on re-sync embeds ONLY that chunk, not all N", async () => {
    const store = makeMemoryStore();
    const { client, calls } = makeSpyEmbedder();

    // Write a markdown file that produces ≥2 chunks (two distinct headings)
    const initial = "# Section A\n\nContent A here.\n\n# Section B\n\nContent B here.";
    await writeFile(join(tempDir, "multi.md"), initial);

    const { runSync } = await import("../../src/commands/sync.js");

    // First sync — embed all chunks
    const r1 = await runSync({ root: tempDir, projectId: "proj", store, embeddings: client });
    expect(r1.ingested).toBeGreaterThan(0);

    // Count how many distinct texts were embedded across all calls in sync 1
    const textsEmbeddedSync1 = calls.flatMap((c) => c).length;
    expect(textsEmbeddedSync1).toBeGreaterThanOrEqual(2); // ≥2 chunks

    const callsAfterFirst = calls.length;

    // Edit ONLY Section A — Section B is unchanged
    const modified = "# Section A\n\nContent A CHANGED.\n\n# Section B\n\nContent B here.";
    await writeFile(join(tempDir, "multi.md"), modified);

    // Second sync — must embed ONLY the changed chunk (1 text), NOT all N
    const r2 = await runSync({ root: tempDir, projectId: "proj", store, embeddings: client });

    const newCalls = calls.slice(callsAfterFirst);
    const textsEmbeddedSync2 = newCalls.flatMap((c) => c).length;

    // KEY assertion: only 1 chunk re-embedded (the changed Section A)
    expect(textsEmbeddedSync2).toBe(1);

    // The file still counts as ingested (it changed)
    expect(r2.ingested).toBeGreaterThan(0);
  });

  it("T-8.3: unchanged chunks keep their stored vector after re-sync (no data loss)", async () => {
    const store = makeMemoryStore();
    const { client } = makeSpyEmbedder();

    const initial = "# Alpha\n\nAlpha content.\n\n# Beta\n\nBeta content.";
    await writeFile(join(tempDir, "data.md"), initial);

    const { runSync } = await import("../../src/commands/sync.js");

    await runSync({ root: tempDir, projectId: "proj", store, embeddings: client });

    // Record all chunk ids and their vectors after sync 1
    const afterSync1 = [...(store.data.get("proj") ?? [])];
    expect(afterSync1.length).toBeGreaterThanOrEqual(2);

    // Edit only Alpha section
    const modified = "# Alpha\n\nAlpha content UPDATED.\n\n# Beta\n\nBeta content.";
    await writeFile(join(tempDir, "data.md"), modified);

    await runSync({ root: tempDir, projectId: "proj", store, embeddings: client });

    const afterSync2 = [...(store.data.get("proj") ?? [])];

    // Beta chunk must still be present with SAME vector (reused, not re-embedded)
    for (const oldChunk of afterSync1) {
      if (oldChunk.content === "# Beta\n\nBeta content.") {
        const newChunk = afterSync2.find((c) => c.id === oldChunk.id);
        expect(newChunk).toBeDefined();
        expect(newChunk!.vector).toEqual(oldChunk.vector);
      }
    }

    // Total chunk count should equal or exceed sync1 (no chunks dropped)
    expect(afterSync2.length).toBeGreaterThanOrEqual(afterSync1.length);
  });

  it("T-8.4: old-format manifest (no chunks field) triggers full re-embed on next content change", async () => {
    const store = makeMemoryStore();
    const { client, calls } = makeSpyEmbedder();

    await writeFile(join(tempDir, "legacy.md"), "# Head\n\nBody text here.\n\n# Foot\n\nFooter text.");

    const { runSync } = await import("../../src/commands/sync.js");

    // First sync — populates manifest with chunks field
    await runSync({ root: tempDir, projectId: "proj", store, embeddings: client });
    const textsSync1 = calls.flatMap((c) => c).length;
    expect(textsSync1).toBeGreaterThanOrEqual(2); // ≥2 chunks

    // Simulate old-format manifest: strip the chunks field from the persisted entry
    const { readFile, writeFile: wf } = await import("node:fs/promises");
    const { join: pjoin } = await import("node:path");
    const manifestPath = pjoin(tempDir, ".project-brain", "hashes.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf-8"));
    for (const key of Object.keys(raw)) {
      delete raw[key].chunks;
    }
    await wf(manifestPath, JSON.stringify(raw, null, 2));

    const callsAfterStrip = calls.length;

    // Now edit the file so it is re-processed (triggers Phase B with old-format manifest)
    await writeFile(join(tempDir, "legacy.md"), "# Head\n\nBody text UPDATED.\n\n# Foot\n\nFooter text.");

    // Re-sync: no chunks field → treat as "all chunks changed" → re-embeds ALL chunks (not just 1)
    await runSync({ root: tempDir, projectId: "proj", store, embeddings: client });
    const textsSync2 = calls.slice(callsAfterStrip).flatMap((c) => c).length;
    // Safe fallback: re-embeds all N chunks, not just the 1 that changed
    expect(textsSync2).toBeGreaterThanOrEqual(2);

    const callsAfterFallback = calls.length;

    // Third sync — manifest now has chunks, file unchanged → only the 1 changed chunk
    // was saved, but now the manifest is up-to-date, nothing changed → 0 embeds
    await runSync({ root: tempDir, projectId: "proj", store, embeddings: client });
    expect(calls.length).toBe(callsAfterFallback);
  });

  it("T-8.5: re-sync with N unchanged chunks calls getChunksByIds exactly ONCE, not N times", async () => {
    const store = makeMemoryStoreWithBatchLookup();
    const { client } = makeSpyEmbedder();

    // 4 headings → 4 chunks. Only "Four" changes on the second sync, so the
    // FILE hash changes (file re-enters Phase B) while One/Two/Three keep
    // matching chunk hashes → 3 unchanged chunks to look up in one batch.
    //
    // Note: rewriting a file with byte-identical content does NOT reach
    // Phase B at all — Phase A's file-level hash dedup (sync.ts ~line 253)
    // marks it "skipped" (mtime-only update) before Phase B ever runs, so
    // that scenario can't exercise getChunksByIds.
    const initial = "# One\n\nFirst.\n\n# Two\n\nSecond.\n\n# Three\n\nThird.\n\n# Four\n\nFourth.";
    await writeFile(join(tempDir, "four.md"), initial);

    const { runSync } = await import("../../src/commands/sync.js");

    await runSync({ root: tempDir, projectId: "proj", store, embeddings: client });

    const modified = "# One\n\nFirst.\n\n# Two\n\nSecond.\n\n# Three\n\nThird.\n\n# Four\n\nFourth CHANGED.";
    await writeFile(join(tempDir, "four.md"), modified);

    await runSync({ root: tempDir, projectId: "proj", store, embeddings: client });

    // Exactly one batched call for however many unchanged chunks there were —
    // NOT one call per chunk (would be 3) and not zero (unbatched fallback path).
    expect(store.batchCalls).toBe(1);
  });
});
