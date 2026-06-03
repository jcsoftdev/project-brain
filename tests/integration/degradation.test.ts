import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { VECTOR_DIM } from "../../src/constants.js";
import { handleIngest } from "../../src/tools/ingest.js";
import { handleSearch } from "../../src/tools/search.js";
import { handleForget } from "../../src/tools/forget.js";
import { handleListModules, handleGetModule } from "../../src/tools/modules.js";
import { handleHealth } from "../../src/tools/health.js";
import type { EmbeddingClient, ToolDeps } from "../../src/types.js";

let tmpDir: string;
let store: LanceDbStore;

/** Embeddings that simulate being unavailable. */
const unavailableEmbeddings: EmbeddingClient = {
  embed: async () => null,
  isAvailable: async () => false,
};

/** Working embeddings for seeding data. */
const workingEmbeddings: EmbeddingClient = {
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.5)),
  isAvailable: async () => true,
};

describe("Integration: graceful degradation", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "brain-degrade-"));
    store = new LanceDbStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("add_knowledge fails gracefully when embeddings down", async () => {
    const deps: ToolDeps = { store, embeddings: unavailableEmbeddings };

    const result = await handleIngest(
      { project: "demo", content: "test", source: "x.md", module: "core" },
      deps
    );
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("EMBEDDINGS_UNAVAILABLE");
  });

  it("search_context returns error when embeddings down", async () => {
    const deps: ToolDeps = { store, embeddings: unavailableEmbeddings };

    const result = await handleSearch(
      { project: "demo", query: "anything" },
      deps
    );
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("unavailable");
  });

  it("store-only tools work normally when embeddings are down", async () => {
    // First seed some data with working embeddings
    const seedDeps: ToolDeps = { store, embeddings: workingEmbeddings };
    await handleIngest(
      { project: "demo", content: "Auth logic", source: "auth.ts", module: "auth" },
      seedDeps
    );

    // Now switch to unavailable embeddings
    const deps: ToolDeps = { store, embeddings: unavailableEmbeddings };

    // list_modules works
    const listResult = await handleListModules({ project: "demo" }, deps);
    expect(listResult.isError).toBeFalsy();
    const listData = JSON.parse(listResult.content[0].text);
    expect(listData.modules).toContain("auth");

    // get_module works
    const getResult = await handleGetModule({ project: "demo", module: "auth" }, deps);
    expect(getResult.isError).toBeFalsy();
    const getData = JSON.parse(getResult.content[0].text);
    expect(getData.chunks.length).toBe(1);

    // delete_knowledge works
    const delResult = await handleForget({ project: "demo", source: "auth.ts" }, deps);
    expect(delResult.isError).toBeFalsy();
  });

  it("check_health reports accurate degraded state", async () => {
    const deps: ToolDeps = { store, embeddings: unavailableEmbeddings };

    const result = await handleHealth({ project: "demo" }, deps);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.store).toBe("connected");
    expect(data.embeddings).toBe("unavailable");
  });

  it("server never crashes regardless of subsystem state", async () => {
    const deps: ToolDeps = { store, embeddings: unavailableEmbeddings };

    // Run all tools — none should throw
    const results = await Promise.all([
      handleIngest({ project: "demo", content: "x", source: "x.md", module: "m" }, deps),
      handleSearch({ project: "demo", query: "x" }, deps),
      handleListModules({ project: "demo" }, deps),
      handleGetModule({ project: "demo", module: "m" }, deps),
      handleForget({ project: "demo", source: "x.md" }, deps),
      handleHealth({ project: "demo" }, deps),
    ]);

    // All should return valid ToolResult (not throw)
    for (const r of results) {
      expect(r.content).toBeDefined();
      expect(r.content[0].type).toBe("text");
    }
  });
});
