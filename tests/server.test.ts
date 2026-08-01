import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

  /**
   * Structural tools can target another project by id, and each resolution
   * opens that project's graph.db. Those handles used to live in a plain Map:
   * no bound, and nothing in the shutdown path ever closed them, so a
   * long-lived `serve` accumulated a SQLite connection per project it was ever
   * asked about. Driven through the REAL registered tool so the cache is
   * exercised by the same `graphFor` the server hands its tools — asserting on
   * the returned object alone would not prove it is the one actually used.
   */
  it("caches foreign project graphs in a closeable, bounded cache", async () => {
    const { registerProject } = await import("../src/store/project-registry.js");
    const home = await mkdtemp(join(tmpdir(), "pb-foreign-"));
    try {
      const ownRoot = join(home, "own");
      const foreignRoot = join(home, "other");
      const dataDir = join(home, "registry");

      // A real foreign project: graph.db with one symbol, registered by id.
      const foreignGraphPath = join(foreignRoot, ".project-brain", GRAPH_DB_FILE);
      await mkdir(join(foreignRoot, ".project-brain"), { recursive: true });
      const seed = new GraphStore(openGraphDb(foreignGraphPath));
      seed.replaceFile("other.ts", "typescript", "h", 1, [
        { name: "elsewhere", kind: "function", signature: "fn elsewhere", start_line: 1, end_line: 2, edges: [] },
      ]);
      seed.close();
      await registerProject(dataDir, "other-project", foreignRoot);

      const { server, foreignGraphs } = await createServer({
        dbPath: join(home, "store"),
        embeddings: stubEmbeddings,
        projectRoot: ownRoot,
        dataDir,
      });

      const findSymbol = (server as any)._registeredTools["find_symbol"];
      const result = await findSymbol.handler({ name: "elsewhere", project: "other-project" }, {});

      // Resolution really went through the foreign graph, not a silent empty answer.
      expect(JSON.stringify(result)).toContain("elsewhere");
      expect(foreignGraphs.size, "foreign graph handle was not cached").toBe(1);

      // Second lookup reuses the handle rather than opening another.
      await findSymbol.handler({ name: "elsewhere", project: "other-project" }, {});
      expect(foreignGraphs.size).toBe(1);

      // And the server can actually release it — the part that was missing.
      foreignGraphs.close();
      expect(foreignGraphs.size).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
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
