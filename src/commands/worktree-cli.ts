import {
  createWorktree,
  defaultDeps,
  finishWorktree,
  pickTarget,
  resolveRepo,
  sweepWorktrees,
  type FinishOutcome,
  type LifecycleDeps,
} from "./worktree-lifecycle.js";

const VALUE_FLAGS = new Set(["--base", "--branch"]);

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function positional(args: string[]): string | undefined {
  return args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1] ?? ""));
}

function describe(o: FinishOutcome, applied: boolean): string {
  const where = o.managed ? "" : "  [outside .claude]";
  const branch = o.branch ?? "(detached)";
  if (o.error) return `failed     ${o.path} (${branch}): ${o.error}`;
  if (o.removed) {
    const kept = o.branchDeleted ? "branch deleted" : `branch kept${o.branchNote ? ` (${o.branchNote})` : ""}`;
    return `removed    ${o.path} (${branch}) — ${kept}${where}`;
  }
  if (o.heldBack) return `kept       ${o.path} (${branch}) — finished, but outside .claude; pass --include-outside to remove${where}`;
  if (o.finished) return `${applied ? "finished  " : "would remove"} ${o.path} (${branch})${where}`;
  return `keeping    ${o.path} (${branch})${where}: ${o.reasons.join("; ")}`;
}

async function finish(args: string[], deps: LifecycleDeps): Promise<void> {
  const apply = args.includes("--yes");
  const repo = resolveRepo(deps);
  if (!repo) {
    console.error("Not inside a git repository.");
    process.exitCode = 1;
    return;
  }
  const entry = pickTarget(positional(args), repo, deps);
  if (typeof entry === "string") {
    console.error(entry);
    process.exitCode = 1;
    return;
  }
  const outcome = await finishWorktree(entry, repo, deps, apply);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ applied: apply, ...outcome }, null, 2));
  } else {
    console.log(describe(outcome, apply));
    if (outcome.finished && !apply) console.log("Dry run. Re-run with --yes to remove it.");
  }
  if (!outcome.finished || outcome.error) process.exitCode = 1;
}

async function sweep(args: string[], deps: LifecycleDeps): Promise<void> {
  const apply = args.includes("--yes");
  const quiet = args.includes("--quiet");
  const result = await sweepWorktrees(deps, { apply, branches: args.includes("--branches"), includeOutside: args.includes("--include-outside") });
  if (!result) {
    if (!quiet) console.error("Not inside a git repository.");
    return;
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify({ applied: apply, ...result }, null, 2));
    return;
  }

  const removed = result.worktrees.filter((o) => o.removed);
  if (quiet) {
    if (removed.length > 0) {
      console.log(`project-brain: removed ${removed.length} finished worktree(s): ${removed.map((o) => o.path.split("/").pop()).join(", ")}`);
    }
    return;
  }

  if (result.worktrees.length === 0) console.log("No linked worktrees.");
  for (const o of result.worktrees) console.log(describe(o, apply));
  if (result.branches.length > 0) {
    console.log("");
    console.log("Merged local branches without a worktree:");
    for (const b of result.branches) {
      console.log(`  ${b.deleted ? "deleted " : ""}${b.name}${b.note ? ` (${b.note})` : ""}`);
    }
    if (!(apply && args.includes("--branches"))) console.log("Delete them with: worktree sweep --yes --branches");
  }
  if (!apply && result.worktrees.some((o) => o.finished)) console.log("\nDry run. Re-run with --yes to remove the finished ones.");
}

async function create(args: string[], deps: LifecycleDeps): Promise<void> {
  const name = positional(args);
  if (!name) {
    console.error("Usage: project-brain worktree create <name> [--base <ref>] [--branch <name>] [--skip-index]");
    process.exitCode = 1;
    return;
  }
  const skipIndex = args.includes("--skip-index");
  const { path, branch, status, dependencies } = await createWorktree(deps, {
    name,
    base: flagValue(args, "--base"),
    branch: flagValue(args, "--branch"),
    init: async (root) => {
      const { runInit } = await import("./init.js");
      const { makeProgressPrinter } = await import("../indexer/progress.js");
      const { onProgress, clear } = makeProgressPrinter();
      await runInit({ root, skipIndex, onProgress });
      clear();
    },
  });
  console.log(`Created ${path} on branch ${branch}`);
  console.log(dependencies.note);
  console.log(`projectId  ${status.projectId}`);
  console.log(`port-registry pair: project="${status.project}" worktree="${status.worktree}"`);
}

export async function executeLifecycle(sub: "create" | "finish" | "sweep", args: string[]): Promise<void> {
  try {
    const deps = await defaultDeps();
    if (sub === "create") await create(args, deps);
    else if (sub === "finish") await finish(args, deps);
    else await sweep(args, deps);
  } catch (err) {
    // A hook running `sweep --quiet` must never fail the host; interactive use still gets the exit code.
    if (args.includes("--quiet")) return;
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
