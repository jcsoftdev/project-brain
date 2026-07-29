import { describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import { SERVER_INSTRUCTIONS, GRAPH_DB_FILE } from "../src/constants.js";
import { openGraphDb } from "../src/graph/db.js";
import { GraphStore } from "../src/graph/store.js";
import type { EmbeddingClient } from "../src/types.js";

const stubEmbeddings: EmbeddingClient = {
  dim: 768,
  model: "nomic-embed-text",
  embed: async () => null,
  isAvailable: async () => true,
};

describe("Server", () => {
  it("createServer returns a configured McpServer", async () => {
    const { server } = await createServer({ dbPath: "/tmp/brain-test-server", embeddings: stubEmbeddings });
    expect(server).toBeDefined();
  });

  // The server holds its graph handle for the whole process lifetime. A CLI
  // `reindex`/`init` in another process replaces .project-brain/graph.db, and
  // without a path to revalidate against the server keeps serving the old
  // (unlinked) inode until it is restarted.
  it("its graph serves an out-of-band rebuild without a restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "pb-server-graph-"));
    try {
      const { graph } = await createServer({
        dbPath: join(root, "store"),
        embeddings: stubEmbeddings,
        projectRoot: root,
      });
      const graphPath = join(root, ".project-brain", GRAPH_DB_FILE);

      for (const suffix of ["", "-wal", "-shm"]) {
        await rm(`${graphPath}${suffix}`, { force: true });
      }
      const rebuilt = new GraphStore(openGraphDb(graphPath));
      rebuilt.replaceFile("after-rebuild.ts", "typescript", "h", 1, [
        { name: "fresh", kind: "function", signature: "fn fresh", start_line: 1, end_line: 2, edges: [] },
      ]);
      rebuilt.close();

      expect(graph.listFiles()).toEqual(["after-rebuild.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("registers all 18 tools", async () => {
    const { toolNames } = await createServer({ dbPath: "/tmp/brain-test-server", embeddings: stubEmbeddings });
    const expected = [
      "search_context",
      "search_code",
      "add_knowledge",
      "list_modules",
      "get_module",
      "delete_knowledge",
      "check_health",
      "expand_context",
      "find_symbol",
      "find_callers",
      "find_callees",
      "impact",
      "trace_path",
      "repo_map",
      "list_projects",
      "delete_project",
      "manage_adr",
      "get_architecture",
      "sync_project",
    ];
    for (const name of expected) {
      expect(toolNames).toContain(name);
    }
    expect(toolNames.length).toBe(19);
  });

  it("wires SERVER_INSTRUCTIONS into the server (instructions const is passed)", async () => {
    const { instructions } = await createServer({ dbPath: "/tmp/brain-test-server", embeddings: stubEmbeddings });
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
  });
});
