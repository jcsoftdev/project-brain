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
 * Two layers. The deterministic one checks the imports an edit newly introduces
 * against `.project-brain/architecture.json`. The fuzzy one asks Jev whether the
 * edit breaks an OKF `Constraint` that anchors the file — and only runs when a
 * TypeSafe token exists, since it sends the edit and the constraint text to
 * api.typesafe.ai.
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
import { resolveRerankerToken } from "../rerank/token.js";
import type { TypesafeFetchFn } from "../typesafe/client.js";
import {
  judgeConstraints,
  loadCoveringConstraints,
  type ArchAsk,
  type ConstraintViolation,
  type CoveringConstraint,
  type EditSnapshot,
} from "../arch/jev.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** Everything the Jev layer touches outside the process; absent means the layer is off. */
export interface JevContext {
  /** TypeSafe token, or null when none is configured. */
  token(): Promise<string | null>;
  constraints(root: string, file: string): Promise<CoveringConstraint[]>;
  ask?: ArchAsk;
  fetchFn?: TypesafeFetchFn;
  /** Milliseconds clock, so the Jev call can be cut to what is left of the hook's own timeout. */
  now(): number;
}

/** Matches the `timeout` setup installs; Jev gets what the deterministic layer leaves of it. */
const HOOK_BUDGET_MS = 5000;
const JEV_TIMEOUT_MS = 3000;
/** Leaves room for the process to print and exit before Claude Code kills it. */
const BUDGET_MARGIN_MS = 500;

export interface ArchGuardContext {
  /** Project root owning a file's directory, or null outside any project. */
  findRoot(dir: string): string | null;
  /** UTF-8 content of an absolute path, or null when absent or unreadable. */
  readFile(absPath: string): string | null;
  exists(absPath: string): boolean;
  jev?: JevContext;
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

function snapshotOf(tool: string, input: Record<string, unknown>): EditSnapshot {
  if (tool === "Write") return { tool, content: typeof input.content === "string" ? input.content : "" };
  if (tool === "Edit") {
    return { tool, oldString: String(input.old_string ?? ""), newString: String(input.new_string ?? "") };
  }
  const edits = Array.isArray(input.edits) ? input.edits : [];
  return {
    tool,
    edits: edits.filter(isPlainObject).map((e) => ({ oldString: String(e.old_string ?? ""), newString: String(e.new_string ?? "") })),
  };
}

function constraintReason(violations: ConstraintViolation[]): string {
  return [
    "Edit conflicts with a project constraint (judged by Jev from okf/):",
    ...violations.map((v) => `  "${v.title}" (okf/${v.concept}) — P(violates)=${v.probability.toFixed(2)}`),
    "Fix: read the constraint and rework the edit so it keeps holding. If the constraint no longer applies, " +
      "update or remove that concept in okf/ first.",
  ].join("\n");
}

async function jevViolations(
  jev: JevContext,
  root: string,
  file: string,
  edit: EditSnapshot,
  startedAt: number
): Promise<ConstraintViolation[]> {
  const token = await jev.token();
  if (!token) return [];
  const constraints = await jev.constraints(root, file);
  if (constraints.length === 0) return [];

  const left = HOOK_BUDGET_MS - BUDGET_MARGIN_MS - (jev.now() - startedAt);
  if (left <= 0) return [];
  return judgeConstraints(token, constraints, file, edit, {
    ask: jev.ask,
    fetchFn: jev.fetchFn,
    timeoutMs: Math.min(JEV_TIMEOUT_MS, left),
  });
}

export async function archGuardDecision(payload: unknown, ctx: ArchGuardContext): Promise<GuardDecision> {
  const startedAt = ctx.jev?.now() ?? 0;
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
    if (!config && !ctx.jev) return ALLOW;

    const fileExists = ctx.exists(abs);
    const current = fileExists ? ctx.readFile(abs) : "";
    // A Write to a path that does not exist yet is judged against an empty file:
    // every import in it is new.
    if (current === null) return ALLOW;
    const after = postEditContent(tool, input, current);
    if (after === null) return ALLOW;

    const reasons: string[] = [];
    let block = false;

    if (config) {
      const env: ResolveEnv = {
        exists: (p) => ctx.exists(join(root, p)),
        readFile: (p) => ctx.readFile(join(root, p)),
      };
      const violations = checkBoundaries({ config, file, before: current, after, env });
      if (violations.length > 0) {
        reasons.push(boundaryReason(file, violations));
        block = config.mode === "block";
      }
    }

    // A deterministic block is already final; spending a network call on top of it only adds latency.
    if (!block && ctx.jev && after !== current) {
      const fuzzy = await jevViolations(ctx.jev, root, file, snapshotOf(tool, input), startedAt);
      if (fuzzy.length > 0) {
        reasons.push(constraintReason(fuzzy));
        block = (config?.mode ?? "block") === "block";
      }
    }

    return reasons.length === 0 ? ALLOW : { block, reason: reasons.join("\n\n") };
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
    jev: {
      token: () => resolveRerankerToken(),
      constraints: loadCoveringConstraints,
      now: () => performance.now(),
    },
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
