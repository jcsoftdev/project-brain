import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SpawnFn } from "../bench/mine.js";

const INSTALLERS: Record<string, string> = {
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
  "yarn.lock": "yarn",
};
const LOCKFILES = Object.keys(INSTALLERS);
const MAX_GLOBSTAR_DEPTH = 4;

export interface DependencyFingerprint {
  lockfile: string;
  lockfileHash: string;
}

export type CloneDecision = { clone: true; install: boolean } | { clone: false; reason: string };

export function fingerprintOf(root: string): DependencyFingerprint | null {
  const lockfile = LOCKFILES.find((name) => existsSync(join(root, name)));
  if (!lockfile) return null;
  const lockfileHash = createHash("sha256").update(readFileSync(join(root, lockfile))).digest("hex");
  return { lockfile, lockfileHash };
}

export function decideClone(main: DependencyFingerprint | null, worktree: DependencyFingerprint | null): CloneDecision {
  if (!main || !worktree) return { clone: false, reason: "no lockfile to compare" };
  return { clone: true, install: main.lockfileHash !== worktree.lockfileHash };
}

export function cloneCommand(platform: string, source: string, target: string): { command: string; args: string[] } | null {
  if (platform === "darwin") return { command: "cp", args: ["-c", "-R", source, target] };
  if (platform === "linux") return { command: "cp", args: ["--reflink=always", "-R", source, target] };
  return null;
}

export function installCommand(lockfile: string): { command: string; args: string[] } {
  return { command: INSTALLERS[lockfile] ?? "npm", args: ["install"] };
}

function workspacePatterns(root: string): string[] {
  const patterns: string[] = [];
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
    if (Array.isArray(workspaces)) patterns.push(...workspaces.filter((p: unknown): p is string => typeof p === "string"));
  } catch {}
  try {
    const pnpm = parseYaml(readFileSync(join(root, "pnpm-workspace.yaml"), "utf-8"));
    if (Array.isArray(pnpm?.packages)) patterns.push(...pnpm.packages.filter((p: unknown): p is string => typeof p === "string"));
  } catch {}
  return patterns;
}

function childDirectories(root: string, dir: string): string[] {
  try {
    return readdirSync(join(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith("."))
      .map((entry) => (dir ? posix.join(dir, entry.name) : entry.name));
  } catch {
    return [];
  }
}

function segmentMatcher(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function expandPattern(root: string, pattern: string): string[] {
  const segments = pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/").filter(Boolean);
  let current = [""];
  for (const segment of segments) {
    if (segment === "**") {
      const reached = new Set(current);
      let frontier = current;
      for (let depth = 0; depth < MAX_GLOBSTAR_DEPTH; depth++) {
        frontier = frontier.flatMap((dir) => childDirectories(root, dir));
        frontier.forEach((dir) => reached.add(dir));
      }
      current = [...reached];
    } else if (/[*?]/.test(segment)) {
      const matcher = segmentMatcher(segment);
      current = current.flatMap((dir) => childDirectories(root, dir).filter((child) => matcher.test(posix.basename(child))));
    } else {
      current = current.map((dir) => posix.join(dir, segment)).filter((dir) => existsSync(join(root, dir)));
    }
  }
  return current.filter((dir) => dir !== "" && dir !== ".");
}

export function workspaceDirectories(root: string): string[] {
  const patterns = workspacePatterns(root);
  const included = patterns.filter((p) => !p.startsWith("!")).flatMap((p) => expandPattern(root, p));
  const excluded = new Set(patterns.filter((p) => p.startsWith("!")).flatMap((p) => expandPattern(root, p.slice(1))));
  return ["", ...[...new Set(included)].filter((dir) => !excluded.has(dir)).sort()];
}

export interface DependencyOutcome {
  cloned: boolean;
  note: string;
  folders: string[];
}

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_MAX_BUFFER = 64 * 1024 * 1024;

function failureText(result: ReturnType<SpawnFn>, fallback: string): string {
  const stderr = (result.stderr ?? "").toString().trim().split("\n").pop() ?? "";
  return stderr || result.error?.message || fallback;
}

interface Volume {
  device: string;
  mountPoint: string;
}

export function parseDf(stdout: string): Volume | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  const match = line.match(/^(.+?)\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/);
  return match ? { device: match[1], mountPoint: match[2] } : null;
}

export function filesystemTypeAt(mountOutput: string, mountPoint: string): string | null {
  for (const line of mountOutput.split("\n")) {
    const match = line.match(/^.+? on (.+) \(([^,)]+)/);
    if (match && match[1] === mountPoint) return match[2].trim();
  }
  return null;
}

function volumeOf(path: string, spawn: SpawnFn): Volume | null {
  const result = spawn("df", ["-P", path], { encoding: "utf-8" });
  return result.status === 0 ? parseDf((result.stdout ?? "").toString()) : null;
}

export function darwinCloneBlocker(source: string, target: string, spawn: SpawnFn): string | null {
  const from = volumeOf(source, spawn);
  const to = volumeOf(target, spawn);
  const mounts = spawn("mount", [], { encoding: "utf-8" });
  if (!from || !to || mounts.status !== 0) return "could not tell whether the filesystem supports copy-on-write cloning";
  const mountOutput = (mounts.stdout ?? "").toString();
  for (const volume of [from, to]) {
    const type = filesystemTypeAt(mountOutput, volume.mountPoint);
    if (!type) return "could not tell whether the filesystem supports copy-on-write cloning";
    if (type !== "apfs") return `copy-on-write cloning is unavailable on ${type}`;
  }
  if (from.device !== to.device || from.mountPoint !== to.mountPoint) return "the worktree is on a different volume than the main checkout";
  return null;
}

function installFailure(result: ReturnType<SpawnFn>, command: string, label: string): string {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return `${command} is not available`;
  if (code === "ETIMEDOUT") return `\`${label}\` timed out after ${INSTALL_TIMEOUT_MS / 60000} minutes`;
  if (result.error) return `\`${label}\` failed (${result.error.message})`;
  return `\`${label}\` failed (${failureText(result, result.signal ? `killed by ${result.signal}` : `exit ${result.status}`)})`;
}

export function cloneDependencies(mainRoot: string, worktreePath: string, spawn: SpawnFn, platform: string = process.platform): DependencyOutcome {
  const skipped = (reason: string): DependencyOutcome => ({ cloned: false, note: `node_modules not cloned: ${reason}`, folders: [] });

  const present = workspaceDirectories(mainRoot)
    .map((dir) => posix.join(dir, "node_modules"))
    .filter((folder) => existsSync(join(mainRoot, folder)));
  if (present.length === 0) return skipped("the main checkout has none");

  const real = present.filter((folder) => !lstatSync(join(mainRoot, folder)).isSymbolicLink());
  if (real.length === 0) return skipped("the main checkout's node_modules is a symlink");

  const wanted = real.filter((folder) => existsSync(join(worktreePath, posix.dirname(folder))) && !existsSync(join(worktreePath, folder)));
  if (wanted.length === 0) return skipped("the worktree already has one");

  const worktreeFingerprint = fingerprintOf(worktreePath);
  const decision = decideClone(fingerprintOf(mainRoot), worktreeFingerprint);
  if (!decision.clone) return skipped(decision.reason);

  if (!cloneCommand(platform, mainRoot, worktreePath)) return skipped(`copy-on-write cloning is unsupported on ${platform}`);
  if (platform === "darwin") {
    const blocker = darwinCloneBlocker(join(mainRoot, wanted[0]), worktreePath, spawn);
    if (blocker) return skipped(blocker);
  }

  const absentBefore = workspaceDirectories(worktreePath)
    .map((dir) => posix.join(dir, "node_modules"))
    .filter((folder) => !existsSync(join(worktreePath, folder)));
  const created: string[] = [];
  const remove = (folders: string[]) => folders.forEach((folder) => rmSync(join(worktreePath, folder), { recursive: true, force: true }));

  for (const folder of wanted) {
    const command = cloneCommand(platform, join(mainRoot, folder), join(worktreePath, folder))!;
    const result = spawn(command.command, command.args, { encoding: "utf-8" });
    created.push(folder);
    if (result.status !== 0) {
      remove(created);
      return skipped(`cloning failed (${failureText(result, "cp failed")})`);
    }
  }

  const cloned = `node_modules cloned copy-on-write from the main checkout${created.length > 1 ? ` (${created.length} folders)` : ""}`;
  if (!decision.install) return { cloned: true, note: cloned, folders: created };

  const install = installCommand(worktreeFingerprint!.lockfile);
  const label = `${install.command} ${install.args.join(" ")}`;
  const result = spawn(install.command, install.args, {
    cwd: worktreePath,
    encoding: "utf-8",
    stdio: ["ignore", "ignore", "pipe"],
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: INSTALL_MAX_BUFFER,
  });
  if (result.status === 0 && !result.error) return { cloned: true, note: `${cloned}, then \`${label}\` applied the lockfile changes`, folders: created };

  remove([...new Set([...created, ...absentBefore])]);
  return skipped(`lockfile differs from the main checkout and ${installFailure(result, install.command, label)}`);
}
