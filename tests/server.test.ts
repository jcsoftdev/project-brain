import { describe, it, expect } from "bun:test";
import { createServer } from "../src/server.js";
import { SERVER_INSTRUCTIONS } from "../src/constants.js";
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

  it("registers all 11 tools", async () => {
    const { toolNames } = await createServer({ dbPath: "/tmp/brain-test-server", embeddings: stubEmbeddings });
    const expected = [
      "search_context",
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
    ];
    for (const name of expected) {
      expect(toolNames).toContain(name);
    }
    expect(toolNames.length).toBe(11);
  });

  it("wires SERVER_INSTRUCTIONS into the server (instructions const is passed)", async () => {
    const { instructions } = await createServer({ dbPath: "/tmp/brain-test-server", embeddings: stubEmbeddings });
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
  });
});
