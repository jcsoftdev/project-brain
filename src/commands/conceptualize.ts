import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { EmbeddingClient, VectorStore } from "../types.js";
import { detectModules } from "../indexer/modules.js";
import { getChangedFiles, getCommitMessage, getModuleDiff } from "../git/commit-diff.js";
import { bucketChangedFilesByModule } from "../concept/bucket.js";
import { readConceptDoc, writeConceptDoc } from "../concept/store.js";
import { generateConceptDoc } from "../concept/generate.js";
import type { LlmClient } from "../llm/anthropic-client.js";
import { CONCEPT_MODULE_CAP } from "../constants.js";

export interface ConceptualizeDeps {
  store: VectorStore;
  embeddings: EmbeddingClient;
  llm: LlmClient;
}

export interface ConceptualizeOptions {
  root: string;
  projectId: string;
  onlyModule?: string;
}

export interface ConceptualizeResult {
  processed: string[];
  skipped: string[];
}

/** Conceptualizes the modules touched by the most recent commit (or just `onlyModule`, if given). */
export async function runConceptualize(
  opts: ConceptualizeOptions,
  deps: ConceptualizeDeps
): Promise<ConceptualizeResult> {
  const { root, projectId, onlyModule } = opts;

  const modules = await detectModules(root);
  const changedFiles = getChangedFiles(root);
  const buckets = bucketChangedFilesByModule(changedFiles, modules);
  const touched = [...buckets.keys()].sort();

  const selected = onlyModule ? [onlyModule] : touched.slice(0, CONCEPT_MODULE_CAP);
  const overflow = onlyModule ? [] : touched.slice(CONCEPT_MODULE_CAP);

  const commitMessage = getCommitMessage(root);
  const processed: string[] = [];
  const skipped: string[] = [];

  for (const module of selected) {
    try {
      const diff = getModuleDiff(root, `${module}/`);
      const existingDoc = await readConceptDoc(projectId, module, deps.store);

      let markdown: string | null = null;
      for (let attempt = 0; attempt < 2 && markdown === null; attempt++) {
        try {
          markdown = await generateConceptDoc({ module, commitMessage, diff, existingDoc }, deps.llm);
        } catch {
          markdown = null;
        }
      }

      if (markdown === null) {
        skipped.push(module);
        console.error(`[project-brain] conceptualize: skipped module "${module}" after retry failure`);
        continue;
      }

      await writeConceptDoc(projectId, module, markdown, deps);
      processed.push(module);
    } catch (err) {
      skipped.push(module);
      console.error(`[project-brain] conceptualize: skipped module "${module}": ${err}`);
    }
  }

  if (overflow.length > 0) {
    skipped.push(...overflow);
    console.error(
      `[project-brain] conceptualize: ${overflow.length} module(s) pending (cap ${CONCEPT_MODULE_CAP}/commit): ${overflow.join(", ")}`
    );
  }

  return { processed, skipped };
}

/** Parses CLI args for the conceptualize command into a root path and optional module filter. */
export function parseConceptualizeArgs(args: string[]): { root: string; onlyModule?: string } {
  const moduleFlagIndex = args.indexOf("--module");
  const onlyModule = moduleFlagIndex !== -1 ? args[moduleFlagIndex + 1] : undefined;
  const root =
    args.find((a, i) => !a.startsWith("--") && (moduleFlagIndex === -1 || i !== moduleFlagIndex + 1)) ??
    process.cwd();
  return { root, onlyModule };
}

/** CLI entry point for the conceptualize command. */
export async function execute(args: string[]): Promise<void> {
  const { LanceDbStore } = await import("../store/lancedb.js");
  const { createEmbeddingClient } = await import("../embeddings/factory.js");
  const { createAnthropicClient } = await import("../llm/anthropic-client.js");
  const { DB_PATH, OLLAMA_HOST } = await import("../constants.js");
  const { readTableMeta } = await import("../store/meta.js");

  const { root, onlyModule } = parseConceptualizeArgs(args);

  const configPath = join(root, ".project-brain", "project.json");
  let projectId: string;
  try {
    const raw = await readFile(configPath, "utf-8");
    projectId = JSON.parse(raw).projectId;
  } catch {
    console.error("Error: project not initialized. Run `project-brain init` first.");
    process.exit(1);
  }

  const llm = createAnthropicClient();

  const dbPath = process.env.BRAIN_DATA_DIR || DB_PATH;
  const store = new LanceDbStore(dbPath);
  const storedMeta = await readTableMeta(dbPath, projectId);
  const embeddings = await createEmbeddingClient(process.env.BRAIN_EMBED_MODEL || storedMeta?.model, {
    host: OLLAMA_HOST,
    autoPull: false,
  });

  const result = await runConceptualize({ root, projectId, onlyModule }, { store, embeddings, llm });

  console.log(
    `Conceptualize: ${result.processed.length} module(s) updated${
      result.skipped.length ? `, ${result.skipped.length} skipped` : ""
    }.`
  );
}
