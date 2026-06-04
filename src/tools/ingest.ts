import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Chunk, ToolDeps } from "../types.js";

interface IngestArgs {
  project: string;
  content: string;
  source: string;
  module: string;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Generate deterministic chunk ID from source + content hash. */
function generateId(source: string, content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  const hash = hasher.digest("hex");
  return `${source}::${hash.slice(0, 8)}`;
}

/** Generate content hash. */
function contentHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

/** Handle add_knowledge logic (exported for testing). */
export async function handleIngest(args: IngestArgs, deps: ToolDeps): Promise<ToolResult> {
  const { project, content, source, module } = args;

  const vectors = await deps.embeddings.embed([content]);
  if (!vectors) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "Cannot ingest — embedding service unavailable.",
            code: "EMBEDDINGS_UNAVAILABLE",
          }),
        },
      ],
      isError: true,
    };
  }

  const id = generateId(source, content);
  const chunk: Chunk = {
    id,
    vector: vectors[0],
    content,
    source,
    module,
    content_hash: contentHash(content),
    updated_at: Date.now(),
  };

  const tableMeta = deps.embeddings.model
    ? { model: deps.embeddings.model, dim: deps.embeddings.dim }
    : undefined;
  await deps.store.ensureTable(project, tableMeta);
  await deps.store.upsert(project, [chunk]);
  await deps.store.buildIndexes(project);

  return {
    content: [{ type: "text", text: JSON.stringify({ id, source, status: "stored" }) }],
  };
}

/** Register add_knowledge tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "add_knowledge",
    {
      description: "Persist a note, decision, or context chunk into this project's brain so future sessions retrieve it semantically.",
      inputSchema: {
        project: z.string().describe("Project identifier"),
        content: z.string().describe("Text content to store"),
        source: z.string().describe("Origin file or identifier"),
        module: z.string().describe("Logical module name"),
      },
    },
    async (args) => handleIngest(args, deps)
  );
}
