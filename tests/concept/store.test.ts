import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { VECTOR_DIM } from "../../src/constants.js";
import { readConceptDoc, writeConceptDoc } from "../../src/concept/store.js";
import type { EmbeddingClient } from "../../src/types.js";

const mockEmbeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
  embed: async (texts) =>
    texts.map((t) => {
      const vec = new Array(VECTOR_DIM).fill(0);
      for (let i = 0; i < t.length; i++) vec[i % VECTOR_DIM] += t.charCodeAt(i) / 1000;
      return vec;
    }),
  isAvailable: async () => true,
};

describe("concept store", () => {
  let tmpDir: string;
  let store: LanceDbStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "brain-concept-store-"));
    store = new LanceDbStore(tmpDir);
    await store.ensureTable("testproj", { model: "mock", dim: VECTOR_DIM });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a concept doc chunked by heading and reads it back", async () => {
    const markdown = "## Purpose\n\nHandles login.\n\n## Key Files\n\nauth/login.ts\n";
    await writeConceptDoc("testproj", "auth", markdown, { store, embeddings: mockEmbeddings });

    const doc = await readConceptDoc("testproj", "auth", store);
    expect(doc).toContain("Handles login");
    expect(doc).toContain("auth/login.ts");
    // Verify heading order is preserved during reassembly
    expect(doc.indexOf("Handles login")).toBeLessThan(doc.indexOf("auth/login.ts"));
  });

  it("replaces the previous doc for the same module on rewrite", async () => {
    await writeConceptDoc("testproj", "auth", "## Purpose\n\nOld purpose.\n", {
      store,
      embeddings: mockEmbeddings,
    });
    await writeConceptDoc("testproj", "auth", "## Purpose\n\nNew purpose.\n", {
      store,
      embeddings: mockEmbeddings,
    });

    const doc = await readConceptDoc("testproj", "auth", store);
    expect(doc).toContain("New purpose");
    expect(doc).not.toContain("Old purpose");
  });
});
