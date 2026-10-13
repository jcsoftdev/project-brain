import { refreshCatalog } from "../toolcatalog/catalog.js";
import { TOOL_SPEC } from "../toolcatalog/shortlist.js";
import { warmVectors } from "../skills/semantic.js";
import type { ToolEntry } from "../toolcatalog/live.js";

/**
 * Embeds the catalog with the current project's model so the prompt hook finds
 * tool vectors already cached; its own warm budget is far too small for ~1k
 * tools. Best-effort: no project, no Ollama or any failure just leaves the
 * hook on its keyword fallback.
 */
async function warmToolVectors(tools: ToolEntry[]): Promise<void> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { DB_PATH, OLLAMA_HOST } = await import("../constants.js");
    const { readTableMeta } = await import("../store/meta.js");
    const { createEmbeddingClient } = await import("../embeddings/factory.js");
    const config = JSON.parse(await readFile(join(process.cwd(), ".project-brain", "project.json"), "utf-8")) as { projectId?: string };
    if (!config.projectId) return;
    const meta = await readTableMeta(DB_PATH, config.projectId);
    const embeddings = await createEmbeddingClient(meta?.model, { host: OLLAMA_HOST, autoPull: false, recordedDim: meta?.dim });
    await warmVectors(tools, TOOL_SPEC, embeddings);
  } catch {
    // Warming is an optimization.
  }
}

/** `project-brain tool-catalog refresh` — rebuilds the MCP tool catalog the prompt hook reads. */
export async function execute(args: string[]): Promise<void> {
  if (args[0] !== "refresh") {
    console.error("usage: project-brain tool-catalog refresh");
    process.exit(1);
  }
  const { catalog, servers, live, fallback } = await refreshCatalog({ projectDir: process.cwd() });
  await warmToolVectors(catalog.tools);
  console.log(`tool-catalog: ${catalog.tools.length} tools (${live} live from ${servers} servers, ${fallback} from transcripts)`);
}
