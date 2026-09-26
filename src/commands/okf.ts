import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { OkfBundleError, readBundle } from "../okf/bundle.js";
import { syncBundle, type SyncBundleDeps } from "../okf/sync.js";
import type { OkfIssue } from "../okf/validate.js";
import { auditBundle, impactedConcepts, readSymbols, type AuditGraph, type StaleFinding } from "../okf/audit.js";
import {
  applyJudgeVerdicts,
  compareJudges,
  formatCompareReport,
  judgeStaleFindings,
  type JudgeComparison,
  type StaleJudge,
} from "../okf/judge.js";
import { OKF_JUDGE_MODEL } from "../constants.js";
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
      "Usage: project-brain okf <init|validate|sync|audit|candidates> [dir] [--symbol <name>] [--json] [--judge]",
      "",
      `  init       scaffold an empty bundle (index.md + log.md). Never overwrites.`,
      `  validate   check bundle conformance (SPEC v0.2 §11). Offline.`,
      `  sync       index the bundle's concepts into this project's brain.`,
      `  audit      compare the bundle against the code graph: broken anchors,`,
      `             stale knowledge, undocumented code, missing links.`,
      `  candidates mine "fix:" commits and rank them for a possible OKF concept.`,
      "",
      `  --symbol         with audit: name the concepts to re-read after <name> changes.`,
      `  --json           with audit|candidates: print one JSON object instead of prose.`,
      `  --judge          with audit: ask a model whether each "code-changed"`,
      `                   stale finding's reasoning still holds. Opt-in — costs money`,
      `                   (or a TypeSafe token), and never auto-attests.`,
      `  --judge-model    jev|claude (default claude) — which model judges --judge findings.`,
      `  --judge-compare  with audit: run BOTH judges and print an agreement table`,
      `                   plus disagreements, for hand labelling. Implies --judge.`,
      `  --since          with candidates: only commits after this rev or date.`,
      `  --limit          with candidates: how many ranked candidates to print (default 20).`,
      `  dir defaults to ./${DEFAULT_BUNDLE_DIR}`,
    ].join("\n")
  );
}

const SYMBOL_FLAG = "--symbol";
const JSON_FLAG = "--json";
const JUDGE_FLAG = "--judge";
const JUDGE_MODEL_FLAG = "--judge-model";
const JUDGE_COMPARE_FLAG = "--judge-compare";
const SINCE_FLAG = "--since";
const LIMIT_FLAG = "--limit";

export type JudgeModel = "jev" | "claude";

interface ParsedArgs {
  positional: string[];
  symbol?: string;
  json: boolean;
  judge: boolean;
  judgeModel: JudgeModel;
  judgeCompare: boolean;
  since?: string;
  limit?: number;
}

/** Splits positionals from every recognized `--flag`/`--flag=value` pair, ignoring unknown flags. */
function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  let symbol: string | undefined;
  let json = false;
  let judge = false;
  let judgeModel: JudgeModel = "claude";
  let judgeCompare = false;
  let since: string | undefined;
  let limit: number | undefined;

  const valueOf = (flag: string, arg: string, i: number): { value: string; next: number } | null => {
    if (arg === flag) return { value: args[++i] ?? "", next: i };
    if (arg.startsWith(`${flag}=`)) return { value: arg.slice(flag.length + 1), next: i };
    return null;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    const symbolMatch = valueOf(SYMBOL_FLAG, arg, i);
    if (symbolMatch) {
      symbol = symbolMatch.value;
      i = symbolMatch.next;
      continue;
    }
    const judgeModelMatch = valueOf(JUDGE_MODEL_FLAG, arg, i);
    if (judgeModelMatch) {
      if (judgeModelMatch.value === "jev" || judgeModelMatch.value === "claude") judgeModel = judgeModelMatch.value;
      i = judgeModelMatch.next;
      continue;
    }
    const sinceMatch = valueOf(SINCE_FLAG, arg, i);
    if (sinceMatch) {
      since = sinceMatch.value;
      i = sinceMatch.next;
      continue;
    }
    const limitMatch = valueOf(LIMIT_FLAG, arg, i);
    if (limitMatch) {
      const parsed = Number(limitMatch.value);
      if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
      i = limitMatch.next;
      continue;
    }
    if (arg === JSON_FLAG) {
      json = true;
      continue;
    }
    if (arg === JUDGE_FLAG) {
      judge = true;
      continue;
    }
    if (arg === JUDGE_COMPARE_FLAG) {
      judgeCompare = true;
      continue;
    }
    if (!arg.startsWith("--")) positional.push(arg);
  }
  return { positional, symbol, json, judge, judgeModel, judgeCompare, since, limit };
}

/** CLI entry point for the okf command. */
export async function execute(args: string[]): Promise<void> {
  const { positional, symbol, json, judge, judgeModel, judgeCompare, since, limit } = parseArgs(args);
  const [action, dirArg] = positional;
  if (
    action !== "init" &&
    action !== "validate" &&
    action !== "sync" &&
    action !== "audit" &&
    action !== "candidates"
  ) {
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
      let judgeDeps: OkfAuditDeps["judge"];
      // --judge-compare needs both judges regardless of --judge; asking for
      // it implies judging is on, so the user never has to pass both flags.
      if (judge || judgeCompare) {
        const { createClaudeJudge, createGitDiffFetcher } = await import("../okf/judge.js");
        const { createJevJudge } = await import("../okf/jev-judge.js");
        const { resolveRerankerToken } = await import("../rerank/token.js");

        const buildJudge = async (model: JudgeModel): Promise<StaleJudge | null> => {
          if (model === "claude") return createClaudeJudge();
          const token = await resolveRerankerToken();
          return token ? createJevJudge(token) : null;
        };

        const primary = await buildJudge(judgeModel);
        if (!primary) {
          console.error(
            "--judge-model jev needs a TypeSafe token: set TYPESAFE_API_KEY, or configure one via `project-brain setup` — skipping --judge"
          );
        } else {
          let compare: StaleJudge | undefined;
          if (judgeCompare) {
            const otherModel: JudgeModel = judgeModel === "claude" ? "jev" : "claude";
            compare = (await buildJudge(otherModel)) ?? undefined;
            if (!compare) {
              console.error(
                "--judge-compare needs a TypeSafe token too: set TYPESAFE_API_KEY — comparing skipped, judging with " +
                  `${judgeModel} alone`
              );
            }
          }
          judgeDeps = { judge: primary, diff: createGitDiffFetcher(root), compare };
        }
      }

      const { output, ok } = await runOkfAudit(dir, {
        graph,
        clock: createGitClock(root),
        exists: (relPath) => existsSync(join(root, relPath)),
        repoRoot: root,
        symbol,
        json,
        judge: judgeDeps,
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
  /** Print one JSON object instead of prose. Exit code is unaffected. */
  json?: boolean;
  /**
   * Opt-in Claude judgment of `code-changed` stale findings (`--judge`).
   * Absent by default — judging costs money and needs live credentials.
   */
  judge?: {
    judge: StaleJudge;
    /** Diff evidence for one finding, or null when it could not be produced. */
    diff(finding: StaleFinding): string | null;
    concurrency?: number;
    maxDiffChars?: number;
    /**
     * `--judge-compare`: run this SECOND judge over the same eligible
     * findings and report agreement/disagreement against the primary one.
     * Purely diagnostic — never affects `stale`/`judged`/`ok`, which are
     * always driven by the primary judge alone.
     */
    compare?: StaleJudge;
  };
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
  // Built once and shared with impactedConcepts below: each call otherwise ran
  // its own graph.pageRank(), the most expensive step in an audit, over the
  // exact same graph.
  const symbols = readSymbols(deps.graph);
  const report = auditBundle(bundle, layout, { ...deps, symbols });
  const impacted =
    deps.symbol !== undefined
      ? impactedConcepts(deps.symbol, bundle, layout, { ...deps, symbols, anchors: report.anchors })
      : undefined;

  let compare: JudgeComparison[] | undefined;

  if (deps.judge) {
    const eligible = report.stale.filter((f) => f.reason === "code-changed");
    console.log(`judging ${plural(eligible.length, "stale finding")} with ${OKF_JUDGE_MODEL}`);
    if (eligible.length > 0) {
      const conceptBody = (concept: string) => bundle.files.find((f) => f.path === concept)?.document.body ?? "";
      try {
        const verdicts = await judgeStaleFindings(eligible, {
          judge: deps.judge.judge,
          diff: deps.judge.diff,
          conceptBody,
          concurrency: deps.judge.concurrency,
          maxDiffChars: deps.judge.maxDiffChars,
        });
        const { stale, judged } = applyJudgeVerdicts(report.stale, verdicts);
        report.stale = stale;
        report.judged = judged;

        if (deps.judge.compare) {
          // --judge-compare: diagnostic only, never touches stale/judged/ok.
          compare = await compareJudges(eligible, {
            primary: deps.judge.judge,
            compare: deps.judge.compare,
            diff: deps.judge.diff,
            conceptBody,
            concurrency: deps.judge.concurrency,
            maxDiffChars: deps.judge.maxDiffChars,
          });
        }
      } catch (error) {
        if (!(error instanceof Anthropic.AuthenticationError)) throw error;
        // Judging never got off the ground — report the plain, unjudged audit
        // rather than failing the whole command over it.
        console.error("--judge needs Anthropic credentials: set ANTHROPIC_API_KEY or run `ant auth login`");
      }
    }
  }

  const ok = report.broken.length === 0 && report.stale.length === 0;

  if (deps.json) {
    const jsonReport: Record<string, unknown> = {
      ok,
      broken: report.broken.map((anchor) => ({
        concept: anchor.concept,
        resource: anchor.resource,
        reason: RESOLUTION_REASON[anchor.resolution],
        ...(anchor.hint ? { hint: anchor.hint } : {}),
      })),
      stale: report.stale,
      judged: report.judged,
      ambiguous: report.ambiguous,
      unattested: report.unattested,
      coverage: report.coverage,
      links: report.links,
    };
    if (impacted !== undefined) jsonReport.impacted = impacted;
    if (compare !== undefined) jsonReport.compare = compare;
    return { output: JSON.stringify(jsonReport, null, 2), ok };
  }

  const concepts = new Set(report.anchors.map((a) => a.concept)).size;

  const lines = [
    `project-brain okf audit — ${dir}`,
    `  ${plural(report.anchors.length, "anchor")} across ${plural(concepts, "concept")}`,
  ];

  if (report.broken.length > 0) {
    lines.push("", `  ${plural(report.broken.length, "broken anchor")}:`);
    for (const anchor of report.broken) {
      const hint = anchor.hint ? ` — did you mean \`${anchor.hint}\`?` : "";
      lines.push(`  ✗ ${anchor.concept} → ${anchor.resource} (${RESOLUTION_REASON[anchor.resolution]})${hint}`);
    }
  }

  if (report.ambiguous.length > 0) {
    lines.push("", `  ${plural(report.ambiguous.length, "ambiguous anchor")} — same name twice in the file; anchor by #L<start>-L<end> instead:`);
    for (const anchor of report.ambiguous) {
      lines.push(`  ? ${anchor.concept} → ${anchor.resource} (several symbols named \`${anchor.symbol}\`)`);
    }
  }

  if (report.stale.length > 0) {
    lines.push("", `  ${plural(report.stale.length, "stale concept")}:`);
    for (const finding of report.stale) {
      const base =
        finding.reason === "expired"
          ? `  ! ${finding.concept} — ${finding.path} expired ${finding.expiresAt}`
          : finding.reason === "uncommitted"
            ? `  ! ${finding.concept} — ${finding.path} has uncommitted changes, attested ${finding.attestedAt}`
            : `  ! ${finding.concept} — ${finding.path} changed ${finding.changedAt}, attested ${finding.attestedAt}`;
      lines.push(finding.judge ? `${base} (judged ${finding.judge.verdict}: ${finding.judge.reason})` : base);
    }
  }

  if (report.judged.length > 0) {
    lines.push(
      "",
      `  ${plural(report.judged.length, "concept")} judged still valid — confirm and add a \`verified\` entry:`
    );
    for (const finding of report.judged) {
      lines.push(`  ✓ ${finding.concept} — ${finding.judge?.reason}`);
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

  if (impacted !== undefined) {
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

  if (compare !== undefined) {
    lines.push("", "  --judge-compare:", formatCompareReport(compare));
  }

  if (ok) lines.push("", "  every anchor resolves, and no concept is older than the code it explains");
  return { output: lines.join("\n"), ok };
}
