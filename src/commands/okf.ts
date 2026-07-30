import { join } from "node:path";
import { OkfBundleError, readBundle } from "../okf/bundle.js";
import { syncBundle, type SyncBundleDeps } from "../okf/sync.js";
import type { OkfIssue } from "../okf/validate.js";
import { auditBundle, impactedConcepts, type AuditGraph } from "../okf/audit.js";
import type { CodeClock } from "../git/last-changed.js";

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
/**
 * `repoRoot` is REQUIRED here, unlike in syncBundle where it is optional for the
 * bundle-is-the-repo case. Omitting it from a command run inside a repository
 * produces bundle-relative ids while runSync writes repo-relative ones for the
 * very same files, so the two pipelines delete each other's chunks on every run.
 * Making it required turns that into a compile error instead of a silent one.
 */
export type OkfSyncDeps = SyncBundleDeps & { repoRoot: string };

export async function runOkfSync(dir: string, deps: OkfSyncDeps): Promise<string> {
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

/**
 * Re-render <root>/CLAUDE.md so its knowledge-bundle section appears now that a
 * bundle exists. `project-brain init` ran before it did, so that section was
 * omitted; without this the host is never told the bundle is there.
 *
 * Reads the same project.json init wrote, so projectId and stack stay in sync
 * rather than being re-detected differently here.
 */
async function refreshProjectRules(root: string): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const { writeProjectRules } = await import("../rules/project.js");

  const raw = await readFile(join(root, ".project-brain", "project.json"), "utf-8");
  const config = JSON.parse(raw) as { projectId: string; stack: any; modules?: string[] };

  await writeProjectRules(root, {
    projectId: config.projectId,
    stack: config.stack,
    modules: config.modules,
    hasOkfBundle: true,
  });
}

function usage(): void {
  console.error(
    [
      "Usage: project-brain okf <init|validate|sync|audit> [dir] [--symbol <name>]",
      "",
      `  init       scaffold an empty bundle (index.md + log.md). Never overwrites.`,
      `  validate   check bundle conformance (SPEC v0.2 §11). Offline.`,
      `  sync       index the bundle's concepts into this project's brain.`,
      `  audit      compare the bundle against the code graph: broken anchors,`,
      `             stale knowledge, undocumented code, missing links.`,
      "",
      `  --symbol   with audit: name the concepts to re-read after <name> changes.`,
      `  dir defaults to ./${DEFAULT_BUNDLE_DIR}`,
    ].join("\n")
  );
}

const SYMBOL_FLAG = "--symbol";

/** Splits positionals from `--symbol <name>` / `--symbol=<name>`, ignoring unknown flags. */
function parseArgs(args: string[]): { positional: string[]; symbol?: string } {
  const positional: string[] = [];
  let symbol: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === SYMBOL_FLAG) {
      symbol = args[++i];
      continue;
    }
    if (arg.startsWith(`${SYMBOL_FLAG}=`)) {
      symbol = arg.slice(SYMBOL_FLAG.length + 1);
      continue;
    }
    if (!arg.startsWith("--")) positional.push(arg);
  }
  return { positional, symbol };
}

/** CLI entry point for the okf command. */
export async function execute(args: string[]): Promise<void> {
  const { positional, symbol } = parseArgs(args);
  const [action, dirArg] = positional;
  if (action !== "init" && action !== "validate" && action !== "sync" && action !== "audit") {
    usage();
    process.exit(1);
    return;
  }

  const { findProjectRoot, openProjectGraph, resolveProjectId } = await import("./resolve-project.js");
  const root = findProjectRoot() ?? process.cwd();
  const dir = dirArg ?? join(root, DEFAULT_BUNDLE_DIR);

  if (action === "init") {
    const { runOkfInit } = await import("../okf/init.js");
    const { created, skipped } = await runOkfInit({ root, dir, refreshRules: () => refreshProjectRules(root) });

    console.log(`project-brain okf init — ${dir}`);
    for (const name of created) console.log(`  created  ${name}`);
    for (const name of skipped) console.log(`  exists   ${name} (left alone)`);
    if (created.length === 0) {
      console.log("\n  Bundle already present. Nothing to do.");
    } else {
      console.log(
        "\n  Write your first concept with the `brain-okf` skill, or by hand:" +
          `\n    ${DEFAULT_BUNDLE_DIR}/gotchas/<slug>.md   type: Gotcha, anchored with resource: ../src/...` +
          "\n  Then: project-brain okf validate && project-brain okf sync"
      );
    }
    return;
  }

  if (action === "validate") {
    const { output, ok } = await runOkfValidate(dir);
    console.log(output);
    if (!ok) process.exit(1);
    return;
  }

  if (action === "audit") {
    const { createGitClock } = await import("../git/last-changed.js");
    const { existsSync } = await import("node:fs");

    // The audit is entirely about the join with the call graph. Without one,
    // every anchor would look unresolvable and every symbol uncovered — a
    // report full of findings that are really just "you have not synced yet".
    const graph = openProjectGraph(root);
    if (!graph) {
      console.error("No structural graph at this project root yet — run `project-brain sync` first.");
      process.exit(1);
      return;
    }

    try {
      const { output, ok } = await runOkfAudit(dir, {
        graph,
        clock: createGitClock(root),
        exists: (relPath) => existsSync(join(root, relPath)),
        repoRoot: root,
        symbol,
      });
      console.log(output);
      if (!ok) process.exit(1);
    } finally {
      graph.close();
    }
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
    console.log(await runOkfSync(dir, { project, store, embeddings, repoRoot: root }));
  } catch (error) {
    console.error(error instanceof OkfBundleError ? error.message : String(error));
    process.exit(1);
  }
}

export interface OkfAuditDeps {
  graph: AuditGraph;
  clock: CodeClock;
  exists(repoRelPath: string): boolean;
  repoRoot: string;
  coverageLimit?: number;
  /** Report which concepts to re-read after this symbol changes. */
  symbol?: string;
}

const RESOLUTION_REASON: Record<string, string> = {
  "missing-file": "file not found",
  "missing-symbol": "symbol not found",
};

/**
 * Compares the bundle against the code graph and reports what drifted.
 *
 * Only findings the author can act on with certainty fail the run: an anchor
 * pointing at code that is gone, and knowledge older than the code it explains.
 * Coverage gaps, link suggestions, and unattested concepts are backlog — they
 * are true of every young bundle, and failing on them would make the audit
 * useless in CI from the first commit.
 */
export async function runOkfAudit(
  dir: string,
  deps: OkfAuditDeps
): Promise<{ output: string; ok: boolean }> {
  let bundle;
  try {
    bundle = await readBundle(dir);
  } catch (error) {
    const message = error instanceof OkfBundleError ? error.message : String(error);
    return { output: `${message}\nCreate it, or pass a path: project-brain okf audit <dir>`, ok: false };
  }

  const layout = { bundleRoot: dir, repoRoot: deps.repoRoot };
  const report = auditBundle(bundle, layout, deps);
  const concepts = new Set(report.anchors.map((a) => a.concept)).size;

  const lines = [
    `project-brain okf audit — ${dir}`,
    `  ${plural(report.anchors.length, "anchor")} across ${plural(concepts, "concept")}`,
  ];

  if (report.broken.length > 0) {
    lines.push("", `  ${plural(report.broken.length, "broken anchor")}:`);
    for (const anchor of report.broken) {
      lines.push(`  ✗ ${anchor.concept} → ${anchor.resource} (${RESOLUTION_REASON[anchor.resolution]})`);
    }
  }

  if (report.stale.length > 0) {
    lines.push("", `  ${plural(report.stale.length, "stale concept")}:`);
    for (const finding of report.stale) {
      lines.push(
        finding.reason === "uncommitted"
          ? `  ! ${finding.concept} — ${finding.path} has uncommitted changes, attested ${finding.attestedAt}`
          : `  ! ${finding.concept} — ${finding.path} changed ${finding.changedAt}, attested ${finding.attestedAt}`
      );
    }
  }

  if (report.unattested.length > 0) {
    lines.push("", `  ${plural(report.unattested.length, "concept")} never attested:`);
    for (const concept of report.unattested) lines.push(`  - ${concept}`);
  }

  if (report.links.length > 0) {
    lines.push("", `  ${plural(report.links.length, "link suggestion")}:`);
    for (const link of report.links) {
      lines.push(`  ~ ${link.from} → ${link.to} (${link.because.caller} calls ${link.because.callee})`);
    }
  }

  if (report.coverage.length > 0) {
    lines.push("", `  top ${report.coverage.length} ranked by importance, explained by nothing:`);
    for (const gap of report.coverage) lines.push(`  · ${gap.name} (${gap.kind}) ${gap.file}`);
  }

  if (deps.symbol !== undefined) {
    const impacted = impactedConcepts(deps.symbol, bundle, layout, deps);
    lines.push("");
    if (impacted.length === 0) {
      lines.push(`  no concept explains code affected by \`${deps.symbol}\``);
    } else {
      lines.push(`  ${plural(impacted.length, "concept")} to re-read after \`${deps.symbol}\` changes:`);
      for (const item of impacted) {
        lines.push(`  → ${item.concept} (via ${item.via.name} in ${item.via.file})`);
      }
    }
  }

  const ok = report.broken.length === 0 && report.stale.length === 0;
  if (ok) lines.push("", "  every anchor resolves, and no concept is older than the code it explains");
  return { output: lines.join("\n"), ok };
}
