import { spawnSync } from "node:child_process";

function runGit(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** Files changed in the given commit (default HEAD), relative to repo root. --root handles the initial commit, which diff-tree otherwise reports as empty. */
export function getChangedFiles(root: string, commit = "HEAD"): string[] {
  const out = runGit(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit]);
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Full commit message (subject + body) of the given commit. */
export function getCommitMessage(root: string, commit = "HEAD"): string {
  return runGit(root, ["log", "-1", "--format=%B", commit]).trim();
}

/** Diff for the given commit, scoped to files under modulePath (e.g. "src/"). */
export function getModuleDiff(root: string, modulePath: string, commit = "HEAD"): string {
  return runGit(root, ["show", commit, "--format=", "--", modulePath]);
}
