import { join } from "node:path";
import { OkfBundleError, readBundle } from "../okf/bundle.js";
import { syncBundle, type SyncBundleDeps } from "../okf/sync.js";
import type { OkfIssue } from "../okf/validate.js";

/**
 * Default bundle location, relative to the project root.
 *
 * Deliberately a committed directory rather than `.project-brain/`: an OKF
 * bundle exists to be shared and versioned (§2 names a git repo as the
 * recommended distribution), and knowledge hidden in a machine-local cache
 * cannot be reviewed, diffed, or handed to another team.
 */
export const DEFAULT_BUNDLE_DIR = "okf";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function renderIssues(issues: OkfIssue[]): string[] {
  return issues.map((i) => `  ✗ ${i.path} [${i.rule}] ${i.message}`);
}

/**
 * Checks a bundle against SPEC §11 and reports what is there.
 * Never throws — a missing directory is reported as a message so the CLI can
 * exit cleanly with a useful hint instead of a stack trace.
 */
export async function runOkfValidate(dir: string): Promise<{ output: string; ok: boolean }> {
  let bundle;
  try {
    bundle = await readBundle(dir);
  } catch (error) {
    const message = error instanceof OkfBundleError ? error.message : String(error);
    return { output: `${message}\nCreate it, or pass a path: project-brain okf validate <dir>`, ok: false };
  }

  const concepts = bundle.files.filter((f) => f.kind === "concept").length;
  const lines = [
    `project-brain okf — ${dir}`,
    `  version: ${bundle.okfVersion ?? "undeclared"}`,
    `  ${plural(concepts, "concept")}, ${plural(bundle.files.length - concepts, "structural file")}`,
  ];

  if (bundle.issues.length === 0) {
    lines.push("  conformant (SPEC v0.2 §11)");
    return { output: lines.join("\n"), ok: true };
  }

  lines.push(`  ${plural(bundle.issues.length, "conformance issue")}:`, ...renderIssues(bundle.issues));
  return { output: lines.join("\n"), ok: false };
}

/**
 * Indexes a bundle into the project's brain and summarizes the result.
 *
 * Non-conformant documents are listed explicitly. They are skipped rather than
 * indexed, so saying so is the difference between the author fixing the
 * frontmatter and quietly wondering why their note never surfaces in a search.
 */
export async function runOkfSync(dir: string, deps: SyncBundleDeps): Promise<string> {
  const result = await syncBundle(dir, deps);

  const lines = [
    `project-brain okf — indexed ${dir}`,
    `  ${plural(result.concepts, "concept")} → ${plural(result.chunks, "chunk")}`,
  ];
  if (result.removed.length > 0) {
    lines.push(`  ${plural(result.removed.length, "concept")} removed from the index:`);
    lines.push(...result.removed.map((s) => `  - ${s}`));
  }
  if (result.issues.length > 0) {
    lines.push(`  ${plural(result.issues.length, "document")} not indexed — conformance:`);
    lines.push(...renderIssues(result.issues));
  }
  return lines.join("\n");
}

function usage(): void {
  console.error(
    [
      "Usage: project-brain okf <validate|sync> [dir]",
      "",
      `  validate   check bundle conformance (SPEC v0.2 §11). Offline.`,
      `  sync       index the bundle's concepts into this project's brain.`,
      "",
      `  dir defaults to ./${DEFAULT_BUNDLE_DIR}`,
    ].join("\n")
  );
}

/** CLI entry point for the okf command. */
export async function execute(args: string[]): Promise<void> {
  const [action, dirArg] = args.filter((a) => !a.startsWith("--"));
  if (action !== "validate" && action !== "sync") {
    usage();
    process.exit(1);
    return;
  }

  const { findProjectRoot, resolveProjectId } = await import("./resolve-project.js");
  const root = findProjectRoot() ?? process.cwd();
  const dir = dirArg ?? join(root, DEFAULT_BUNDLE_DIR);

  if (action === "validate") {
    const { output, ok } = await runOkfValidate(dir);
    console.log(output);
    if (!ok) process.exit(1);
    return;
  }

  const { DB_PATH, OLLAMA_HOST } = await import("../constants.js");
  const { LanceDbStore } = await import("../store/lancedb.js");
  const { createEmbeddingClient } = await import("../embeddings/factory.js");
  const { readTableMeta } = await import("../store/meta.js");

  const project = await resolveProjectId(root);
  const store = new LanceDbStore(DB_PATH);
  // Match the model the project's index was built with; embedding a bundle
  // with a different model than the code chunks would produce a dim mismatch.
  const storedMeta = await readTableMeta(DB_PATH, project);
  const embeddings = await createEmbeddingClient(
    process.env.BRAIN_EMBED_MODEL || storedMeta?.model || undefined,
    { host: OLLAMA_HOST, autoPull: true }
  );

  try {
    console.log(await runOkfSync(dir, { project, store, embeddings }));
  } catch (error) {
    console.error(error instanceof OkfBundleError ? error.message : String(error));
    process.exit(1);
  }
}
