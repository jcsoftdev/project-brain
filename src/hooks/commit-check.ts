/**
 * PreToolUse hook: a Jev (TypeSafe System 1) pre-filter that runs before `git commit`.
 *
 * Two jobs share ONE `ask()` call, so the hook pays one round trip:
 *   - review triage: binary risk questions about the staged diff. Jev only ESCALATES.
 *     A routine change prints nothing, and there is deliberately no "approved" output, because a
 *     fast model's silence must never read as a review having happened.
 *   - test-coverage warn: for staged source files that ship without any staged test, whether the
 *     change falls in a category the user's testing rules say needs one. Always a warning, never
 *     test-first, never blocking.
 *
 * Output follows `arch-guard`: `warn` (default) exits 0 with `additionalContext` on stdout, which
 * Claude Code delivers next to the tool result; `block` exits 2 with the reason on stderr and
 * applies to the review triage alone.
 *
 * Fails OPEN on anything it cannot read or time. The staged diff is sent to api.typesafe.ai, so
 * without a TypeSafe token the hook does nothing at all.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ArchAsk } from "../arch/jev.js";
import { DATA_DIR } from "../constants.js";
import { resolveRerankerToken } from "../rerank/token.js";
import { ask as jevAsk, type ChoiceAnswer, type ChoiceQuestion, type TypesafeFetchFn } from "../typesafe/client.js";

export type CommitCheckMode = "warn" | "block";

/** Matches the `timeout` setup installs; Jev gets what the git calls leave of it. */
const HOOK_BUDGET_MS = 5000;
const JEV_TIMEOUT_MS = 3000;
/** Leaves room for the process to print and exit before Claude Code kills it. */
const BUDGET_MARGIN_MS = 500;
const GIT_TIMEOUT_MS = 1500;

/**
 * Characters of staged diff sent to Jev. The request must answer inside the 3s Jev budget and the
 * diff leaves the machine, so it is bounded; the head of a diff carries the file list and the
 * first hunks, which is enough to see what kind of change it is.
 */
export const DIFF_CAP_CHARS = 16000;
/** Every file is another question in the same request; past this the rest add cost, not signal. */
const MAX_TEST_QUESTIONS = 6;

/** P(yes) above which a risk escalates, and P(needs a test) above which a file is named. */
export const ESCALATE_PROBABILITY = 0.8;
/** Below this a risky-looking diff is treated as unjudged and escalated anyway. */
const LOW_CONFIDENCE = 0.5;

export const CONFIG_FILE = "commit-check.json";

const RISKS = {
  security: {
    label: "touches a security or permission boundary",
    question:
      "Does the staged diff in `state.diff` touch security or permission boundaries: authentication, " +
      "secrets, tokens, cryptography, or access checks?",
  },
  destructive: {
    label: "risks data loss or a destructive operation",
    question:
      "Does the staged diff in `state.diff` risk data loss or a destructive operation: deletes, " +
      "migrations, or overwriting existing data?",
  },
  concurrency: {
    label: "changes concurrency or locking",
    question: "Does the staged diff in `state.diff` change concurrency or locking behaviour?",
  },
  contract: {
    label: "changes a public contract or API",
    question:
      "Does the staged diff in `state.diff` change a public contract or API that other code or users depend on?",
  },
} as const;

type RiskId = keyof typeof RISKS;
const RISK_IDS = Object.keys(RISKS) as RiskId[];

const TEST_CATEGORIES = {
  business_rule: "a business rule or calculation",
  bug_fix: "a bug fix",
  security_boundary: "a security or permission boundary",
  data_contract: "a data mapper or a contract between layers",
} as const;

type TestCategory = keyof typeof TEST_CATEGORIES;
const NO_TEST_NEEDED = "no_test_needed";

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift|scala|c|cc|cpp|h|hpp)$/;
const TEST_PATH = [
  /(?:^|\/)(?:tests?|__tests__|specs?)\//,
  /\.(?:test|spec)\.[^/]+$/,
  /_test\.(?:go|py|rb|rs)$/,
  /(?:^|\/)test_[^/]+\.py$/,
  /Tests?\.(?:java|kt|cs|swift)$/,
];

/** Only consulted when Jev gave no usable answer: a cheap guess at "this diff deserves a look anyway". */
const RISKY_LOOKING =
  /auth|secret|password|passwd|token|crypt|permission|credential|migrat|drop\s+(?:table|column|database)|delete\s+from|truncate|rm\s+-rf|unlink|rmSync|mutex|semaphore|\block\b|\bchmod\b/i;

export interface CommitCheckContext {
  /** TypeSafe token, or null when none is configured. */
  token(): Promise<string | null>;
  /** stdout of `git <args>` run in `cwd`, or null when git failed. */
  git(cwd: string, args: string[]): Promise<string | null>;
  ask?: ArchAsk;
  fetchFn?: TypesafeFetchFn;
  /** Milliseconds clock, so the Jev call can be cut to what is left of the hook's own timeout. */
  now(): number;
  mode: CommitCheckMode;
}

export interface CommitCheckDecision {
  /** True only in block mode, for a review escalation. */
  block: boolean;
  /** Absent when the commit is routine. */
  message?: string;
}

const SILENT: CommitCheckDecision = { block: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OPERATORS = ["&&", "||", ";", "|", "&", "\n"];

/** Splits a shell line into commands and each command into words, honouring quotes so `-m "a && b"` stays one word. */
function shellWords(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += ch;
      continue;
    }
    const operator = OPERATORS.find((op) => command.startsWith(op, i));
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (operator) {
      endCommand();
      i += operator.length - 1;
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

export interface CommitInvocation {
  /** Directories given with `git -C`, applied in order. */
  dirs: string[];
  /** `-a` / `--all`: the commit takes tracked working-tree changes too, so the staged diff alone undercounts it. */
  all: boolean;
}

/** The first `git commit` in a shell line, or null. Handles `git -C x commit` and `a && git commit`. */
export function parseGitCommit(command: string): CommitInvocation | null {
  for (const words of shellWords(command)) {
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    if (words[i] !== "git") continue;
    i++;

    const dirs: string[] = [];
    while (i < words.length && words[i]!.startsWith("-")) {
      if (words[i] === "-C" && i + 1 < words.length) dirs.push(words[++i]!);
      else if (words[i] === "-c" && i + 1 < words.length) i++;
      i++;
    }
    if (words[i] !== "commit") continue;

    const flags = words.slice(i + 1);
    const all = flags.some((w) => w === "--all" || (/^-[A-Za-z]+$/.test(w) && w.includes("a")));
    return { dirs, all };
  }
  return null;
}

export function isTestPath(path: string): boolean {
  return TEST_PATH.some((re) => re.test(path));
}

export function isSourcePath(path: string): boolean {
  return SOURCE_EXT.test(path) && !isTestPath(path);
}

function truncateDiff(diff: string): string {
  return diff.length > DIFF_CAP_CHARS ? `${diff.slice(0, DIFF_CAP_CHARS)}\n[diff truncated]` : diff;
}

function probabilityOf(answer: ChoiceAnswer, label: string): number {
  const p = answer.probabilities[label];
  if (typeof p === "number") return p;
  return answer.choice === label ? answer.confidence : 0;
}

function questionsFor(files: string[]): Record<string, ChoiceQuestion> {
  const questions: Record<string, ChoiceQuestion> = {};
  for (const id of RISK_IDS) {
    questions[id] = {
      type: "choice",
      instructions: RISKS[id].question,
      criteria: {
        yes: "the diff clearly does this",
        no: "the diff does not, or only incidentally and safely",
      },
    };
  }
  files.forEach((file, i) => {
    questions[`test${i}`] = {
      type: "choice",
      instructions:
        `In the staged diff in \`state.diff\`, does the change to \`${file}\` fall in a category that needs a test? ` +
        "Tests are needed for business rules and calculations, bug fixes, security and permission boundaries, and data " +
        "mappers or contracts between layers. They are usually not needed for UI wiring, copy, styling, or glue.",
      criteria: {
        business_rule: "a business rule or a calculation",
        bug_fix: "a bug fix that deserves a regression test",
        security_boundary: "a security or permission boundary",
        data_contract: "a data mapper or a contract between layers",
        [NO_TEST_NEEDED]: "UI wiring, copy, styling, glue, or anything else that does not need a test",
      },
    };
  });
  return questions;
}

interface Triage {
  /** Risk labels Jev put above the threshold, with their probability. */
  flagged: Array<{ label: string; probability: number }>;
  lowConfidence: boolean;
}

function triage(answers: Record<string, ChoiceAnswer>): Triage {
  const flagged: Triage["flagged"] = [];
  let lowConfidence = false;
  for (const id of RISK_IDS) {
    const answer = answers[id];
    if (!answer) {
      lowConfidence = true;
      continue;
    }
    const probability = probabilityOf(answer, "yes");
    if (probability > ESCALATE_PROBABILITY) flagged.push({ label: RISKS[id].label, probability });
    if (answer.confidence < LOW_CONFIDENCE) lowConfidence = true;
  }
  return { flagged, lowConfidence };
}

function reviewMessage(why: string): string {
  return [
    `project-brain commit-check: ${why}`,
    "Before committing, run an independent deep review of the staged diff (an adversarial review on a stronger model, " +
      "for example a reviewer sub-agent on opus) or ask the user. Jev only escalates; a quiet check is not a review.",
  ].join("\n");
}

function coverageMessage(entries: Array<{ file: string; category: TestCategory }>): string {
  return [
    "project-brain commit-check: staged source changes without any staged test that look like they need one:",
    ...entries.map((e) => `  ${e.file} (${TEST_CATEGORIES[e.category]})`),
    "Add a test for them, preferably in this commit. This is a warning, not a requirement.",
  ].join("\n");
}

function coverageEntries(
  answers: Record<string, ChoiceAnswer>,
  files: string[]
): Array<{ file: string; category: TestCategory }> {
  const entries: Array<{ file: string; category: TestCategory }> = [];
  files.forEach((file, i) => {
    const answer = answers[`test${i}`];
    if (!answer) return;
    if (1 - probabilityOf(answer, NO_TEST_NEEDED) <= ESCALATE_PROBABILITY) return;
    const [category] = (Object.keys(TEST_CATEGORIES) as TestCategory[])
      .map((c) => [c, probabilityOf(answer, c)] as const)
      .sort((a, b) => b[1] - a[1])[0]!;
    entries.push({ file, category });
  });
  return entries;
}

export async function commitCheckDecision(payload: unknown, ctx: CommitCheckContext): Promise<CommitCheckDecision> {
  const startedAt = ctx.now();
  try {
    if (!isPlainObject(payload) || payload.tool_name !== "Bash") return SILENT;
    const input = payload.tool_input;
    if (!isPlainObject(input) || typeof input.command !== "string") return SILENT;
    const invocation = parseGitCommit(input.command);
    if (!invocation) return SILENT;

    const token = await ctx.token();
    if (!token) return SILENT;

    const base = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    const cwd = resolve(base, ...invocation.dirs);
    // `git commit -a` stages tracked changes at commit time, so the index alone would miss them.
    const against = invocation.all ? ["HEAD"] : ["--cached"];
    const [names, diffText] = await Promise.all([
      ctx.git(cwd, ["diff", ...against, "--name-only", "--no-ext-diff"]),
      ctx.git(cwd, ["diff", ...against, "-U2", "--no-ext-diff", "--no-color"]),
    ]);
    if (names === null || diffText === null || diffText.trim() === "") return SILENT;

    const staged = names.split("\n").filter((f) => f !== "");
    const hasStagedTest = staged.some(isTestPath);
    const untested = hasStagedTest ? [] : staged.filter(isSourcePath).slice(0, MAX_TEST_QUESTIONS);

    const left = HOOK_BUDGET_MS - BUDGET_MARGIN_MS - (ctx.now() - startedAt);
    if (left <= 0) return SILENT;

    const diff = truncateDiff(diffText);
    const answers = await (ctx.ask ?? (jevAsk as ArchAsk))(
      token,
      { diff, files: staged.slice(0, 50) },
      questionsFor(untested),
      { fetchFn: ctx.fetchFn, timeoutMs: Math.min(JEV_TIMEOUT_MS, left) }
    );

    const looksRisky = RISKY_LOOKING.test(`${staged.join("\n")}\n${diff}`);
    if (!answers) {
      // Unreachable Jev must not wave a sensitive-looking commit through unremarked, but it never blocks.
      if (!looksRisky) return SILENT;
      return { block: false, message: reviewMessage("Jev was unavailable and this staged diff looks risky.") };
    }

    const { flagged, lowConfidence } = triage(answers);
    const parts: string[] = [];
    let escalated = false;

    if (flagged.length > 0) {
      escalated = true;
      const why = flagged.map((f) => `${f.label} (P=${f.probability.toFixed(2)})`).join("; ");
      parts.push(reviewMessage(`Jev flags this staged diff: ${why}.`));
    } else if (lowConfidence && looksRisky) {
      parts.push(reviewMessage("Jev was unsure about this staged diff and it looks risky."));
    }

    const coverage = coverageEntries(answers, untested);
    if (coverage.length > 0) parts.push(coverageMessage(coverage));

    if (parts.length === 0) return SILENT;
    return { block: ctx.mode === "block" && escalated, message: parts.join("\n\n") };
  } catch {
    return SILENT;
  }
}

/** `{ "mode": "warn" | "block" }`; anything else, including a missing file, is `warn`. */
export function parseMode(raw: string | null): CommitCheckMode {
  if (raw === null) return "warn";
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parsed.mode === "block" ? "block" : "warn";
  } catch {
    return "warn";
  }
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

export function readCommitCheckContext(dataDir: string = DATA_DIR): CommitCheckContext {
  let raw: string | null = null;
  try {
    raw = readFileSync(join(dataDir, CONFIG_FILE), "utf8");
  } catch {
    raw = null;
  }
  return {
    token: () => resolveRerankerToken({ dataDir }),
    git: runGit,
    now: () => performance.now(),
    mode: parseMode(raw),
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

  const out = render(await commitCheckDecision(payload, readCommitCheckContext()));
  if (out.stderr) process.stderr.write(out.stderr);
  if (out.stdout) process.stdout.write(out.stdout);
  process.exit(out.code);
}

export interface HookOutput {
  code: 0 | 2;
  stdout: string;
  stderr: string;
}

export function render(decision: CommitCheckDecision): HookOutput {
  if (decision.block) return { code: 2, stdout: "", stderr: `${decision.message}\n` };
  if (!decision.message) return { code: 0, stdout: "", stderr: "" };
  // Stderr on exit 0 never reaches the model; additionalContext is delivered next to the tool result.
  const output = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: decision.message } };
  return { code: 0, stdout: `${JSON.stringify(output)}\n`, stderr: "" };
}
