import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SpawnFn } from "../bench/mine.js";

const LOCKFILES = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"];

export interface DependencyFingerprint {
  lockfileHash: string;
  nodeMajor: string;
  platform: string;
  arch: string;
}

export type CloneDecision = { clone: true } | { clone: false; reason: string };

export function currentRuntime(): Pick<DependencyFingerprint, "nodeMajor" | "platform" | "arch"> {
  return { nodeMajor: process.versions.node.split(".")[0] ?? "", platform: process.platform, arch: process.arch };
}

export function fingerprintOf(root: string, runtime = currentRuntime()): DependencyFingerprint | null {
  const lockfile = LOCKFILES.find((name) => existsSync(join(root, name)));
  if (!lockfile) return null;
  const lockfileHash = createHash("sha256").update(readFileSync(join(root, lockfile))).digest("hex");
  return { lockfileHash, ...runtime };
}

export function decideClone(main: DependencyFingerprint | null, worktree: DependencyFingerprint | null): CloneDecision {
  if (!main || !worktree) return { clone: false, reason: "no lockfile to compare" };
  if (main.lockfileHash !== worktree.lockfileHash) return { clone: false, reason: "lockfile differs from the main checkout" };
  if (main.nodeMajor !== worktree.nodeMajor) return { clone: false, reason: "Node major differs" };
  if (main.platform !== worktree.platform || main.arch !== worktree.arch) return { clone: false, reason: "platform or arch differs" };
  return { clone: true };
}

export function cloneCommand(platform: string, source: string, target: string): { command: string; args: string[] } | null {
  if (platform === "darwin") return { command: "cp", args: ["-c", "-R", source, target] };
  if (platform === "linux") return { command: "cp", args: ["--reflink=always", "-R", source, target] };
  return null;
}

export interface DependencyOutcome {
  cloned: boolean;
  note: string;
}

export function cloneDependencies(mainRoot: string, worktreePath: string, spawn: SpawnFn, runtime = currentRuntime()): DependencyOutcome {
  const source = join(mainRoot, "node_modules");
  const target = join(worktreePath, "node_modules");
  const skipped = (reason: string): DependencyOutcome => ({ cloned: false, note: `node_modules not cloned: ${reason}` });

  if (!existsSync(source)) return skipped("the main checkout has none");
  if (lstatSync(source).isSymbolicLink()) return skipped("the main checkout's node_modules is a symlink");
  if (existsSync(target)) return skipped("the worktree already has one");

  const decision = decideClone(fingerprintOf(mainRoot, runtime), fingerprintOf(worktreePath, runtime));
  if (!decision.clone) return skipped(decision.reason);

  const command = cloneCommand(runtime.platform, source, target);
  if (!command) return skipped(`copy-on-write cloning is unsupported on ${runtime.platform}`);

  const result = spawn(command.command, command.args, { encoding: "utf-8" });
  if (result.status === 0) return { cloned: true, note: "node_modules cloned copy-on-write from the main checkout" };

  rmSync(target, { recursive: true, force: true });
  return skipped(`filesystem cannot clone (${(result.stderr ?? "").toString().trim() || "cp failed"})`);
}
