import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Chunk, ToolDeps } from "../types.js";
import { toolAnnotations } from "../constants.js";
import { jsonResult, type ToolResult } from "./format.js";
import { parseScopedProjectId } from "../indexer/project-id.js";

interface IngestArgs {
  project: string;
  content: string;
  source: string;
  module: string;
}

/** Generate content hash. */
function contentHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

/** Generate deterministic chunk ID from source + content hash. */
function generateId(source: string, hash: string): string {
  return `${source}::${hash.slice(0, 8)}`;
}

/** Handle add_knowledge logic (exported for testing). */
export async function handleIngest(args: IngestArgs, deps: ToolDeps): Promise<ToolResult> {
  const { content, source, module } = args;

  // Knowledge is durable; a worktree's index is not. A note written from a worktree
  // goes to the BASE project so it survives `worktree prune` and is visible to every
  // sibling worktree and to the main checkout. This is the one write that deliberately
  // ignores the worktree scoping — code chunks stay scoped, reasoning does not.
  const project = parseScopedProjectId(args.project).base;

  const vectors = await deps.embeddings.embed([content]);
  if (!vectors) {
    return jsonResult({
      error: "Cannot ingest — embedding service unavailable.",
      code: "EMBEDDINGS_UNAVAILABLE",
    }, true);
  }

  const hash = contentHash(content);
  const id = generateId(source, hash);
  const chunk: Chunk = {
    id,
    vector: vectors[0],
    content,
    source,
    module,
    content_hash: hash,
    updated_at: Date.now(),
  };

  const tableMeta = deps.embeddings.model
    ? { model: deps.embeddings.model, dim: deps.embeddings.dim }
    : undefined;
  await deps.store.ensureTable(project, tableMeta);
  await deps.store.upsert(project, [chunk]);

  return jsonResult({ id, source, project, status: "stored" });
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
      outputSchema: {
        id: z.string(),
        source: z.string(),
        project: z.string(),
        status: z.string(),
      },
      annotations: toolAnnotations("add_knowledge"),
    },
    async (args) => handleIngest(args, deps)
  );
}
