import { DATA_DIR } from "../constants.js";
import { readMergedCatalog, refreshCatalog, touchLock, type Part } from "../toolcatalog/catalog.js";
import { TOOL_SPEC } from "../toolcatalog/shortlist.js";
import { modelsWithVectors, warmVectors } from "../skills/semantic.js";
import type { ToolEntry } from "../toolcatalog/live.js";

/** How often a running refresh refreshes its lock, so the hook does not start a second one. */
const HEARTBEAT_MS = 60_000;

/** The model the current project is indexed with, or undefined outside an indexed project. */
async function projectModel(): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { DB_PATH } = await import("../constants.js");
    const { readTableMeta } = await import("../store/meta.js");
    const config = JSON.parse(await readFile(join(process.cwd(), ".project-brain", "project.json"), "utf-8")) as { projectId?: string };
    return config.projectId ? (await readTableMeta(DB_PATH, config.projectId))?.model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Embeds the catalog so the prompt hook finds tool vectors already cached; its
 * own path never embeds tools. Warms for the current project's model when it
 * has one, otherwise for every model that already has a tool vector file, so
 * running this from any directory keeps the models in use current.
 * Best-effort: no Ollama or any failure leaves the hook on its keyword fallback.
 */
async function warmToolVectors(tools: ToolEntry[]): Promise<void> {
  try {
    const { OLLAMA_HOST } = await import("../constants.js");
    const { createEmbeddingClient } = await import("../embeddings/factory.js");
    const own = await projectModel();
    const models = own ? [own] : await modelsWithVectors(TOOL_SPEC.filePrefix);
    for (const model of models) {
      const embeddings = await createEmbeddingClient(model, { host: OLLAMA_HOST, autoPull: false });
      await warmVectors(tools, TOOL_SPEC, embeddings);
    }
  } catch {
    // Warming is an optimization.
  }
}

function partsFromArgs(args: string[]): Part[] {
  const picked = (["user", "project"] as const).filter((p) => args.includes(`--${p}`));
  return picked.length > 0 ? picked : ["user", "project"];
}

/** `project-brain tool-catalog refresh [--user] [--project]` — rebuilds the MCP tool catalog the prompt hook reads. */
export async function execute(args: string[]): Promise<void> {
  if (args[0] !== "refresh") {
    console.error("usage: project-brain tool-catalog refresh [--user] [--project]");
    process.exit(1);
  }
  const parts = partsFromArgs(args);
  const projectDir = process.cwd();
  const beat = setInterval(() => parts.forEach((p) => void touchLock(DATA_DIR, p, projectDir)), HEARTBEAT_MS);
  try {
    const summaries = await refreshCatalog({ projectDir }, parts);
    // Warm what the hook will see (both parts), so a partial refresh does not prune the other part's vectors.
    await warmToolVectors(await readMergedCatalog({ projectDir }));
    const detail = summaries.map((s) => `${s.part}: ${s.live} live from ${s.servers} servers, ${s.fallback} from transcripts`).join("; ");
    console.log(`tool-catalog: ${summaries.reduce((n, s) => n + s.catalog.tools.length, 0)} tools (${detail})`);
  } finally {
    clearInterval(beat);
  }
}
