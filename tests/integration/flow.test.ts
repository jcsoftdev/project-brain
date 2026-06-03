import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { VECTOR_DIM } from "../../src/constants.js";
import { handleIngest } from "../../src/tools/ingest.js";
import { handleSearch } from "../../src/tools/search.js";
import { handleForget } from "../../src/tools/forget.js";
import { handleListModules } from "../../src/tools/modules.js";
import { handleGetModule } from "../../src/tools/modules.js";
import type { EmbeddingClient, ToolDeps } from "../../src/types.js";

let tmpDir: string;
let store: LanceDbStore;
let deps: ToolDeps;

/** Mock embeddings that return deterministic vectors based on content. */
const mockEmbeddings: EmbeddingClient = {
  embed: async (texts) =>
    texts.map((t) => {
      // Create a deterministic vector: hash-like distribution based on char codes
      const vec = new Array(VECTOR_DIM).fill(0);
      for (let i = 0; i < t.length; i++) {
        vec[i % VECTOR_DIM] += t.charCodeAt(i) / 1000;
      }
      return vec;
    }),
  isAvailable: async () => true,
};

describe("Integration: ingest → search → delete flow", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "brain-integ-"));
    store = new LanceDbStore(tmpDir);
    deps = { store, embeddings: mockEmbeddings };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("add_knowledge → search_context returns ingested content", async () => {
    // Ingest
    const ingestResult = await handleIngest(
      { project: "demo", content: "Authentication uses JWT tokens and refresh flows", source: "auth.md", module: "auth" },
      deps
    );
    expect(ingestResult.isError).toBeFalsy();

    // Search
    const searchResult = await handleSearch(
      { project: "demo", query: "Authentication uses JWT tokens and refresh flows" },
      deps
    );
    expect(searchResult.isError).toBeFalsy();
    const data = JSON.parse(searchResult.content[0].text);
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0].content).toContain("JWT");
  });

  it("delete_knowledge → subsequent search returns empty", async () => {
    // Ingest
    await handleIngest(
      { project: "demo", content: "Billing uses Stripe API", source: "billing.md", module: "billing" },
      deps
    );

    // Delete
    const deleteResult = await handleForget(
      { project: "demo", source: "billing.md" },
      deps
    );
    expect(deleteResult.isError).toBeFalsy();

    // Search should return empty
    const searchResult = await handleSearch(
      { project: "demo", query: "Billing uses Stripe API" },
      deps
    );
    const data = JSON.parse(searchResult.content[0].text);
    expect(data.results).toEqual([]);
  });

  it("list_modules and get_module reflect state correctly", async () => {
    // Ingest into two modules
    await handleIngest(
      { project: "demo", content: "Auth middleware", source: "auth.ts", module: "auth" },
      deps
    );
    await handleIngest(
      { project: "demo", content: "Core utils", source: "core.ts", module: "core" },
      deps
    );

    // List modules
    const listResult = await handleListModules({ project: "demo" }, deps);
    const listData = JSON.parse(listResult.content[0].text);
    expect(listData.modules).toContain("auth");
    expect(listData.modules).toContain("core");

    // Get module
    const getResult = await handleGetModule({ project: "demo", module: "auth" }, deps);
    const getData = JSON.parse(getResult.content[0].text);
    expect(getData.chunks.length).toBe(1);
    expect(getData.chunks[0].content).toBe("Auth middleware");

    // Delete auth source
    await handleForget({ project: "demo", source: "auth.ts" }, deps);

    // List modules should no longer contain auth
    const listResult2 = await handleListModules({ project: "demo" }, deps);
    const listData2 = JSON.parse(listResult2.content[0].text);
    expect(listData2.modules).not.toContain("auth");
    expect(listData2.modules).toContain("core");
  });
});
