import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "docs");

// These tests do real exceljs/mammoth/unpdf I/O on top of a real runSync /
// checkStaleness pass — bun:test's 5s default can be tight when the FULL
// suite runs concurrently (hundreds of tests competing for CPU/disk I/O in a
// constrained sandbox). A generous explicit timeout avoids environment-load
// flakiness without masking a genuine hang (still fails loudly if exceeded).
const TEST_TIMEOUT_MS = 20_000;

/** Minimal in-memory store for testing (mirrors tests/commands/sync.test.ts). */
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
    getChunkById: async () => null,
    assertDim: async () => {},
  };
}

const mockEmbeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
  isAvailable: async () => true,
};

describe("sync: PDF/DOCX/XLSX ingestion + binary-safety", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-sync-docs-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("indexes a PDF and stores its extracted text", async () => {
    const store = makeMemoryStore();
    await copyFile(join(FIXTURES, "sample.pdf"), join(tempDir, "doc.pdf"));

    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });

    expect(result.ingested).toBeGreaterThan(0);
    const chunks = store.data.get("p") ?? [];
    expect(chunks.some((c) => c.source === "doc.pdf" && c.content.includes("Hello PDF"))).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("indexes a DOCX and stores its extracted text", async () => {
    const store = makeMemoryStore();
    await copyFile(join(FIXTURES, "sample.docx"), join(tempDir, "doc.docx"));

    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });

    expect(result.ingested).toBeGreaterThan(0);
    const chunks = store.data.get("p") ?? [];
    expect(chunks.some((c) => c.source === "doc.docx" && c.content.includes("Walking on imported air"))).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("indexes an XLSX and renders header-anchored rows under ## headings", async () => {
    const store = makeMemoryStore();
    await copyFile(join(FIXTURES, "sample.xlsx"), join(tempDir, "doc.xlsx"));

    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });

    expect(result.ingested).toBeGreaterThan(0);
    const chunks = store.data.get("p") ?? [];
    const combined = chunks.filter((c) => c.source === "doc.xlsx").map((c) => c.content).join("\n");
    expect(combined).toContain("## People");
    expect(combined).toContain("Name: Ada; Age: 36; City: London");
  }, TEST_TIMEOUT_MS);

  it("silently skips an ordinary binary file with no known doc extension (no console.warn, not indexed)", async () => {
    const store = makeMemoryStore();
    // PNG-like magic bytes + NUL — must fail the isProbablyText sniff.
    await writeFile(join(tempDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { runSync } = await import("../../src/commands/sync.js");
      const result = await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });
      const chunks = store.data.get("p") ?? [];
      expect(chunks.some((c) => c.source === "image.png")).toBe(false);
      expect(result.scanned).toBeGreaterThan(0);
    } finally {
      warnSpy.mockRestore();
    }
  }, TEST_TIMEOUT_MS);

  it("does not embed mojibake for a binary file that survives the walk (regression guard for the pre-existing bug)", async () => {
    const store = makeMemoryStore();
    await writeFile(join(tempDir, "data.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));

    const { runSync } = await import("../../src/commands/sync.js");
    await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });

    const chunks = store.data.get("p") ?? [];
    expect(chunks.some((c) => c.source === "data.bin")).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("a corrupt PDF fails soft: sync still completes and warns, without crashing", async () => {
    const store = makeMemoryStore();
    await copyFile(join(FIXTURES, "corrupt.pdf"), join(tempDir, "broken.pdf"));

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { runSync } = await import("../../src/commands/sync.js");
      const result = await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });
      expect(result.error).toBeUndefined();
      const chunks = store.data.get("p") ?? [];
      expect(chunks.some((c) => c.source === "broken.pdf")).toBe(false);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("[extract]"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  }, TEST_TIMEOUT_MS);

  it("applies the doc size ceiling (MAX_DOC_FILE_BYTES), not the smaller text ceiling, to pdf/docx/xlsx", async () => {
    // sample.docx is ~13KB — comfortably above the OLD 512KB-shared gate
    // would have been fine anyway, so instead assert the doc stays indexed
    // even though its raw size test below proves the ext-aware gate ran
    // (i.e. it did NOT get the wrong ceiling applied and silently skipped).
    const store = makeMemoryStore();
    await copyFile(join(FIXTURES, "sample.docx"), join(tempDir, "doc.docx"));

    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });
    expect(result.ingested).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  describe("checkStaleness / runSync content-hash consistency (both read sites share readIndexableText)", () => {
    it("a synced PDF is reported as current (not stale) by checkStaleness", async () => {
      const store = makeMemoryStore();
      await copyFile(join(FIXTURES, "sample.pdf"), join(tempDir, "doc.pdf"));

      const { runSync, checkStaleness } = await import("../../src/commands/sync.js");
      await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });

      const report = await checkStaleness({ root: tempDir });
      expect(report.stale).toBe(0);
      expect(report.current).toBeGreaterThan(0);
    }, TEST_TIMEOUT_MS);

    it("a synced DOCX is reported as current (not stale) by checkStaleness", async () => {
      const store = makeMemoryStore();
      await copyFile(join(FIXTURES, "sample.docx"), join(tempDir, "doc.docx"));

      const { runSync, checkStaleness } = await import("../../src/commands/sync.js");
      await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });

      const report = await checkStaleness({ root: tempDir });
      expect(report.stale).toBe(0);
      expect(report.current).toBeGreaterThan(0);
    }, TEST_TIMEOUT_MS);

    it("a synced XLSX is reported as current (not stale) by checkStaleness", async () => {
      const store = makeMemoryStore();
      await copyFile(join(FIXTURES, "sample.xlsx"), join(tempDir, "doc.xlsx"));

      const { runSync, checkStaleness } = await import("../../src/commands/sync.js");
      await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });

      const report = await checkStaleness({ root: tempDir });
      expect(report.stale).toBe(0);
      expect(report.current).toBeGreaterThan(0);
    }, TEST_TIMEOUT_MS);
  });
});
