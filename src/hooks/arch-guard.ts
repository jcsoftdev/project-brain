/**
 * PreToolUse guard: refuse an edit that introduces a dependency the project's
 * architecture forbids.
 *
 * Same verified channel as `routing-guard`: exit code 2 blocks the call and hands
 * stderr to the model as the reason, which is the retry prompt we want (the JSON
 * `permissionDecision: "deny"` has been reported as ignored). `warn` mode exits 0
 * with the reason on stderr — PreToolUse has no `additionalContext`, so stderr is
 * the only feedback channel it has, and it is only surfaced in verbose mode.
 *
 * Fails OPEN on anything it cannot read or understand. A guard that blocks
 * because its own input was unparseable would stop all editing, and the user's
 * only fix would be to uninstall it.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { checkBoundaries, type BoundaryViolation, type ResolveEnv } from "../arch/boundaries.js";
import { ARCH_CONFIG_PATH, parseArchConfig, type ArchConfig } from "../arch/config.js";
import { findProjectRoot } from "../commands/resolve-project.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

export interface ArchGuardContext {
  /** Project root owning a file's directory, or null outside any project. */
  findRoot(dir: string): string | null;
  /** UTF-8 content of an absolute path, or null when absent or unreadable. */
  readFile(absPath: string): string | null;
  exists(absPath: string): boolean;
}

export interface GuardDecision {
  block: boolean;
  /** Why the edit was refused (block) or what the rules say about it (warn). */
  reason?: string;
}

const ALLOW: GuardDecision = { block: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface EditSpec {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

function readEdit(raw: unknown): EditSpec | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.old_string !== "string" || typeof raw.new_string !== "string") return null;
  return { oldString: raw.old_string, newString: raw.new_string, replaceAll: raw.replace_all === true };
}

/** Null when the old string is absent: the tool itself would reject the edit, so there is nothing to judge. */
function applyEdit(content: string, edit: EditSpec): string | null {
  if (edit.oldString === "") return null;
  const at = content.indexOf(edit.oldString);
  if (at === -1) return null;
  if (edit.replaceAll) return content.split(edit.oldString).join(edit.newString);
  return content.slice(0, at) + edit.newString + content.slice(at + edit.oldString.length);
}

/**
 * The file as it will read after the tool runs, or null when that cannot be
 * known — an unreadable file, or an old string that is not there.
 */
export function postEditContent(tool: string, input: Record<string, unknown>, current: string | null): string | null {
  if (tool === "Write") return typeof input.content === "string" ? input.content : null;
  if (current === null) return null;

  if (tool === "Edit") {
    const edit = readEdit(input);
    return edit ? applyEdit(current, edit) : null;
  }

  if (!Array.isArray(input.edits)) return null;
  let content = current;
  for (const raw of input.edits) {
    const edit = readEdit(raw);
    const next = edit ? applyEdit(content, edit) : null;
    if (next === null) return null;
    content = next;
  }
  return content;
}

function loadConfig(root: string, ctx: ArchGuardContext): ArchConfig | null {
  const raw = ctx.readFile(join(root, ARCH_CONFIG_PATH));
  if (raw === null) return null;
  try {
    return parseArchConfig(JSON.parse(raw)).config;
  } catch {
    return null;
  }
}

function describeViolation(file: string, v: BoundaryViolation): string {
  const target = v.resolved ? ` -> ${v.resolved}` : "";
  return `  ${file} imports "${v.specifier}"${target} (layer "${v.fromLayer}" -> "${v.toLayer}")`;
}

function boundaryReason(file: string, violations: BoundaryViolation[]): string {
  const rules = [...new Set(violations.map((v) => `"${v.fromLayer}" must not depend on "${v.toLayer}"`))];
  return [
    `Architecture boundary violation (${ARCH_CONFIG_PATH}): ${rules.join("; ")}.`,
    ...violations.map((v) => describeViolation(file, v)),
    "Fix: depend on an abstraction owned by the inner layer (a port/interface) and let an outer layer supply the implementation, " +
      `or drop the import. If the rule itself is wrong, change ${ARCH_CONFIG_PATH}; set "mode": "warn" to stop blocking.`,
  ].join("\n");
}

export async function archGuardDecision(payload: unknown, ctx: ArchGuardContext): Promise<GuardDecision> {
  try {
    if (!isPlainObject(payload)) return ALLOW;
    const tool = payload.tool_name;
    if (typeof tool !== "string" || !EDIT_TOOLS.has(tool)) return ALLOW;
    const input = payload.tool_input;
    if (!isPlainObject(input) || typeof input.file_path !== "string") return ALLOW;

    const abs = input.file_path;
    const root = ctx.findRoot(dirname(abs));
    if (!root) return ALLOW;
    const file = relative(root, abs).split(sep).join("/");
    if (file === "" || file.startsWith("..")) return ALLOW;

    const config = loadConfig(root, ctx);
    if (!config) return ALLOW;

    const fileExists = ctx.exists(abs);
    const current = fileExists ? ctx.readFile(abs) : "";
    // A Write to a path that does not exist yet is judged against an empty file:
    // every import in it is new.
    if (current === null) return ALLOW;
    const after = postEditContent(tool, input, current);
    if (after === null) return ALLOW;

    const env: ResolveEnv = {
      exists: (p) => ctx.exists(join(root, p)),
      readFile: (p) => ctx.readFile(join(root, p)),
    };
    const violations = checkBoundaries({ config, file, before: current, after, env });
    if (violations.length === 0) return ALLOW;

    return { block: config.mode === "block", reason: boundaryReason(file, violations) };
  } catch {
    return ALLOW;
  }
}

export function readGuardContext(): ArchGuardContext {
  return {
    findRoot: (dir) => {
      try {
        return findProjectRoot(dir);
      } catch {
        return null;
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    exists: (path) => existsSync(path),
  };
}

/** CLI entry point: read the hook payload on stdin, exit 2 to block. */
export async function execute(): Promise<void> {
  let payload: unknown = null;
  try {
    payload = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0); // unreadable stdin — allow, per fail-open
  }

  const decision = await archGuardDecision(payload, readGuardContext());
  if (decision.reason) process.stderr.write(`${decision.reason}\n`);
  process.exit(decision.block ? 2 : 0);
}
