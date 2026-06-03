import { join } from "node:path";
import { FileWatcher } from "./watcher.js";
import type { EmbeddingClient, VectorStore } from "./types.js";

interface ServerDeps {
  store: VectorStore;
  embeddings: EmbeddingClient;
}

interface ProjectConfig {
  projectId: string;
  root?: string;
}

/**
 * Attempt to read and validate .project-brain/project.json from the given cwd.
 * Returns the parsed config or null if absent or invalid.
 */
async function readProjectConfig(cwd: string): Promise<ProjectConfig | null> {
  const configPath = join(cwd, ".project-brain", "project.json");
  try {
    const raw = await Bun.file(configPath).text();
    const parsed = JSON.parse(raw);
    if (typeof parsed.projectId !== "string" || parsed.projectId.length === 0) {
      return null;
    }
    return parsed as ProjectConfig;
  } catch {
    return null;
  }
}

/**
 * Attempt to start a FileWatcher for the given cwd.
 *
 * - Reads .project-brain/project.json from cwd.
 * - If present and valid (has projectId), instantiates FileWatcher, starts it,
 *   and returns it.
 * - If config is absent or invalid, returns null. The caller can still serve
 *   normally — the watcher is optional.
 *
 * This helper is extracted from cli.ts so it can be unit-tested without
 * spawning a real MCP server.
 */
export async function maybeStartWatcher(
  cwd: string,
  deps: ServerDeps
): Promise<FileWatcher | null> {
  const config = await readProjectConfig(cwd);
  if (!config) {
    return null;
  }

  const watcher = new FileWatcher({
    root: config.root ?? cwd,
    projectId: config.projectId,
    store: deps.store,
    embeddings: deps.embeddings,
  });

  watcher.start();
  return watcher;
}

/** Minimal stoppable handle — what the shutdown handler needs from a watcher. */
interface Stoppable {
  stop(): Promise<void>;
}

/**
 * Builds a graceful-shutdown handler: stops the watcher (if any) then exits.
 * Extracted from cli.ts so the shutdown path is unit-testable — `exit` is
 * injectable to avoid killing the test process.
 */
export function createShutdownHandler(
  watcher: Stoppable | null,
  exit: (code: number) => void = (code) => process.exit(code)
): () => Promise<void> {
  return async () => {
    if (watcher) await watcher.stop();
    exit(0);
  };
}
