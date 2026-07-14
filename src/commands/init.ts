import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { detectStack } from "../indexer/stack.js";
import { deriveProjectId } from "../indexer/project-id.js";
import { installGitHook } from "../hooks/git.js";
import { upsertContextHook } from "../hooks/claude-settings.js";
import { writeProjectRules } from "../rules/project.js";
import { detectModules, writeModuleStubs } from "../indexer/modules.js";
import { runReindex } from "./reindex.js";
import { runSync } from "./sync.js";
import type { VectorStore, EmbeddingClient } from "../types.js";
import type { ReindexResult } from "./reindex.js";
import type { SyncProgress } from "./sync.js";

const CONFIG_DIR = ".project-brain";
const CONFIG_FILE = "project.json";

export interface InitOptions {
  /** Absolute path to the project root to initialize. Defaults to cwd. */
  root?: string;
  /** Skip git hook installation (useful in tests / non-git repos). */
  skipGitHook?: boolean;
  /** Skip writing project rules into CLAUDE.md (useful in tests). */
  skipRules?: boolean;
  /** Skip the initial index pass (useful in tests / CI / offline envs). */
  skipIndex?: boolean;
  /** Skip installing the .claude/settings.json UserPromptSubmit hook. */
  skipClaudeHook?: boolean;
  /** DI seam: inject fake store and embeddings for tests. */
  indexDeps?: { store: VectorStore; embeddings: EmbeddingClient };
  /** Progress callback forwarded to runReindex. */
  onProgress?: (p: SyncProgress) => void;
}

export interface InitResult {
  root: string;
  projectId: string;
  configPath: string;
  stackDetected: boolean;
  /** true iff runReindex completed without throwing */
  indexed: boolean;
  /** present iff indexed === false (and not skipIndex) */
  indexWarning?: string;
  /** present iff indexed === true */
  indexStats?: ReindexResult;
}

/**
 * Core init logic — testable with injectable options.
 * Idempotent: safe to run multiple times in the same project.
 */
export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const root = options.root ?? process.cwd();
  const dotDir = join(root, CONFIG_DIR);
  const configPath = join(dotDir, CONFIG_FILE);

  // 1. Create .project-brain/ directory
  await mkdir(dotDir, { recursive: true });

  // 2. Read existing config (for idempotency — preserve projectId)
  let existingConfig: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, "utf-8");
    existingConfig = JSON.parse(raw);
  } catch {
    // No existing config — fresh init
  }

  // 3. Derive project ID (stable: use existing one if present)
  const projectId =
    typeof existingConfig.projectId === "string" && existingConfig.projectId.length > 0
      ? existingConfig.projectId
      : await deriveProjectId(root);

  // 4. Detect stack
  const stack = await detectStack(root);

  // 5. Write config
  const config = {
    projectId,
    root,
    stack,
    initializedAt:
      typeof existingConfig.initializedAt === "string"
        ? existingConfig.initializedAt
        : new Date().toISOString(),
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));

  // 6. Detect modules
  const modules = await detectModules(root);

  // 6b. Write module stubs (before index so the index pass includes them)
  if (modules.length > 0) {
    try {
      await writeModuleStubs(root, modules, { projectId });
    } catch {
      // Non-fatal
    }
  }

  // 7. Write project rules into CLAUDE.md unless skipped
  if (!options.skipRules) {
    try {
      await writeProjectRules(root, { projectId, stack, modules });
    } catch {
      // Non-fatal: rules writing should not block init
    }
  }

  // 8. Install git hook unless skipped
  if (!options.skipGitHook) {
    try {
      await installGitHook(root);
    } catch {
      // Non-fatal: project might not be a git repo
    }
  }

  // 8b. Install UserPromptSubmit hook in .claude/settings.json unless skipped
  if (!options.skipClaudeHook) {
    try {
      const claudeDir = join(root, ".claude");
      await mkdir(claudeDir, { recursive: true });

      const settingsPath = join(claudeDir, "settings.json");
      let existing: object | null = null;
      try {
        const raw = await readFile(settingsPath, "utf-8");
        existing = JSON.parse(raw) as object;
      } catch {
        // No existing file — start fresh
      }

      const merged = upsertContextHook(existing);
      await writeFile(settingsPath, JSON.stringify(merged, null, 2));
      console.log("Installed project-brain context hook in .claude/settings.json");
    } catch {
      // Non-fatal: don't block init if hook installation fails
    }
  }

  // 9. Initial index pass unless skipped
  let indexed = false;
  let indexWarning: string | undefined;
  let indexStats: ReindexResult | undefined;

  if (!options.skipIndex) {
    try {
      let store: VectorStore;
      let embeddings: EmbeddingClient;

      if (options.indexDeps) {
        store = options.indexDeps.store;
        embeddings = options.indexDeps.embeddings;
      } else {
        // Dynamic import to keep static import graph lean (same pattern as reindex.execute)
        const { LanceDbStore } = await import("../store/lancedb.js");
        const { createEmbeddingClient } = await import("../embeddings/factory.js");
        const { DB_PATH, OLLAMA_HOST } = await import("../constants.js");
        store = new LanceDbStore(DB_PATH);
        embeddings = await createEmbeddingClient(process.env.BRAIN_EMBED_MODEL || undefined, { host: OLLAMA_HOST, autoPull: true });
      }

      // If already indexed (manifest exists), use incremental sync — not full
      // reindex. Checks for the SQLite manifest store (manifest.db) — the
      // legacy hashes.json is migrated into it on first ManifestStore open,
      // so a fresh project has neither file, and a previously-indexed one
      // (pre- or post-migration) has at least one of them.
      const manifestDbPath = join(root, CONFIG_DIR, "manifest.db");
      const legacyManifestPath = join(root, CONFIG_DIR, "hashes.json");
      let alreadyIndexed = false;
      try { await readFile(manifestDbPath); alreadyIndexed = true; } catch {}
      if (!alreadyIndexed) {
        try { await readFile(legacyManifestPath, "utf-8"); alreadyIndexed = true; } catch {}
      }

      if (alreadyIndexed) {
        indexStats = await runSync({ root, projectId, store, embeddings, onProgress: options.onProgress });
      } else {
        indexStats = await runReindex({ root, projectId, store, embeddings, onProgress: options.onProgress });
      }
      indexed = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      indexWarning = msg || "index step failed";
      indexed = false;
    }
  }

  return {
    root,
    projectId,
    configPath,
    stackDetected: stack.languages.length > 0,
    indexed,
    indexWarning,
    indexStats,
  };
}

/** CLI entry point for the init command. */
export async function execute(args: string[]): Promise<void> {
  const skipIndex = args.includes("--skip-index");
  const skipClaudeHook = args.includes("--no-hook");
  const root = args.find((a) => !a.startsWith("--")) ?? process.cwd();

  console.log(`Initializing project-brain in: ${root}\n`);

  const { makeProgressPrinter } = await import("../indexer/progress.js");
  const { onProgress, clear } = makeProgressPrinter();

  const result = await runInit({ root, skipIndex, skipClaudeHook, onProgress });

  clear();
  console.log(`Project ID: ${result.projectId}`);
  console.log(`Config:     ${result.configPath}`);
  console.log(
    `Stack:      ${result.stackDetected ? "detected" : "not detected (add a manifest file)"}`
  );

  if (result.indexed) {
    console.log(`Indexed:    ${result.indexStats?.ingested ?? 0} files`);
  } else if (result.indexWarning) {
    console.log(`[warning] Initial index skipped: ${result.indexWarning}`);
  } else {
    console.log(
      `Indexed:    skipped (run \`project-brain sync\` once Ollama is available)`
    );
  }

  console.log("\nInitialization complete. Run `project-brain sync` to index files.");
}
