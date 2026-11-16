import { isTrivialPrompt } from "./trivial-prompt.js";
import { pickSkill, pickSuggestions } from "../skills/picker.js";
import type { SharedQuery } from "../skills/semantic.js";
import { judgeContext, parseContextInput, recordContextGateHealth, type ContextJudgeDeps } from "../skills/context-gate.js";
import { fencedForGate } from "../hooks/gate-fence.js";

/**
 * Self-timeout of the global suggest hook. The hook entry allows 10s; this stays
 * well under it so a hung Ollama or Jev never holds a prompt, and covers the
 * prompt embed (bounded by {@link EMBED_BUDGET_MS}) plus Jev's own 1s budget.
 */
export const SUGGEST_TIMEOUT_MS = 5000;

/**
 * How long the prompt embed may take before the keyword shortlist is used instead. Short on
 * purpose: Ollama serves one request at a time, so under load embeds queue and the keyword
 * shortlist is the better answer than waiting behind them.
 */
export const EMBED_BUDGET_MS = 800;

export interface HookInput {
  prompt: string;
  cwd: string | undefined;
  sessionId?: string;
  transcriptPath?: string;
}

/** `prompt` and `cwd` from the UserPromptSubmit JSON; empty/undefined on any malformed input. Never throws. */
export function parseHookInput(raw: string): HookInput {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { prompt: "", cwd: undefined, sessionId: undefined };
    const obj = parsed as Record<string, unknown>;
    return {
      prompt: typeof obj.prompt === "string" ? obj.prompt : "",
      cwd: typeof obj.cwd === "string" && obj.cwd !== "" ? obj.cwd : undefined,
      sessionId: typeof obj.session_id === "string" && obj.session_id !== "" ? obj.session_id : undefined,
      transcriptPath: typeof obj.transcript_path === "string" && obj.transcript_path !== "" ? obj.transcript_path : undefined,
    };
  } catch {
    return { prompt: "", cwd: undefined, sessionId: undefined };
  }
}

/**
 * The embedding client the prompt vector comes from: the cwd project's indexed
 * model when it has one (so skill vectors cache under that model), otherwise the
 * default model. Null when nothing answers.
 */
async function sharedQueryFor(prompt: string, projectDir: string): Promise<SharedQuery | null> {
  try {
    const { join } = await import("node:path");
    const { readFile } = await import("node:fs/promises");
    const { DB_PATH, OLLAMA_HOST } = await import("../constants.js");
    const { createEmbeddingClient } = await import("../embeddings/factory.js");
    const { resolveModel } = await import("../embeddings/registry.js");

    let model: string | undefined;
    let dim: number | undefined;
    try {
      const config = JSON.parse(await readFile(join(projectDir, ".project-brain", "project.json"), "utf-8")) as { projectId?: string };
      if (config.projectId) {
        const { readTableMeta } = await import("../store/meta.js");
        const meta = await readTableMeta(DB_PATH, config.projectId);
        model = meta?.model;
        dim = meta?.dim;
      }
    } catch {
      // No indexed project here — the default model answers.
    }

    // The vector only ranks against cached skill/tool vectors, so with no project width the
    // default model's registry width stands in; that skips the availability probe and the
    // dim-detection embed, which would otherwise be paid from cold on every prompt.
    const embeddings = await createEmbeddingClient(model, {
      host: OLLAMA_HOST,
      autoPull: false,
      lane: "interactive",
      recordedDim: dim ?? (model === undefined ? resolveModel(undefined).dim : undefined),
    });
    const vector = (await embeddings.embed([prompt]))?.[0];
    return vector ? { embeddings, vector } : null;
  } catch {
    return null;
  }
}

export interface SuggestDeps {
  print?: (line: string) => void;
  pick?: typeof pickSuggestions;
  queryEmbedding?: (prompt: string, projectDir: string) => Promise<SharedQuery | null>;
  embedBudgetMs?: number;
  /** Task-switch context for this prompt, or null. Injectable for tests; defaults to reading the transcript. */
  taskContext?: (input: HookInput) => Promise<import("../hooks/task-switch.js").TaskContext | null>;
  /** True the first time a notice of this kind is shown in the session. Injectable for tests. */
  claimNotice?: (sessionId: string, kind: "clear" | "compact") => Promise<boolean>;
  /** The one-time "project-brain updated" block for this session, or null. Injectable for tests. */
  upgradeNotice?: (input: HookInput) => Promise<{ text: string; commit: () => Promise<void> } | null>;
  /** Records whether a Jev skill request was answered. Only the CLI entry passes one, so a test never writes the real file. */
  recordHealth?: (ok: boolean) => Promise<unknown>;
}

/**
 * Whether the conversation still shows this suggestion: same kind and name at the start of a line,
 * whatever description Jev worded it with then.
 */
function alreadySuggested(shown: string, line: string): boolean {
  const name = line.split(" — ")[0]!;
  return `\n${shown}`.includes(`\n${name} — `);
}

/**
 * Printed once, on the first prompt of a session that started on an older version than the binary
 * now running. Hooks and skills are already live; CLAUDE.md is not reloaded, so the routing
 * guidance is repeated here in full. One small file read when the session is unknown or current.
 */
export async function upgradeNoticeFor(
  { sessionId, cwd }: HookInput,
  dataDir?: string,
  version?: string,
  hotSwapEnabled?: boolean
): Promise<{ text: string; commit: () => Promise<void> } | null> {
  if (!sessionId) return null;
  const constants = await import("../constants.js");
  const dir = dataDir ?? constants.DATA_DIR;
  const current = version ?? constants.VERSION;
  const { takeUpgradeNotice, serverSwapped } = await import("../hooks/session-versions.js");
  const notice = await takeUpgradeNotice(dir, sessionId, current);
  if (!notice) return null;

  let server: string;
  if (await serverSwapped(dir, cwd, current, notice.since)) server = "the MCP server already swapped to it";
  else if (hotSwapEnabled ?? (await hotSwapConfigured())) server = "if project-brain tools look stale, run `/mcp reconnect all`";
  else
    server =
      "the MCP server is still the old version: run `/mcp reconnect all` (or `/mcp`) to load the new project-brain tools. " +
      "Hot swap is off because BRAIN_MCP_HOT_SWAP=0 is set; remove it and updates apply without a restart (~16 MB of memory per session)";

  const lines = [`project-brain updated ${notice.from} → ${current} in this session: hooks and skills are already live; ${server}.`];
  // /compact and /clear already reloaded CLAUDE.md; only a session that did not needs the table repeated.
  if (notice.rulesStale) {
    const { buildRoutingReminder } = await import("../hooks/routing-rules.js");
    const reminder = JSON.parse(await buildRoutingReminder(undefined, undefined, true)) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    lines.push("", reminder.hookSpecificOutput?.additionalContext ?? "");
  }
  return { text: lines.join("\n"), commit: notice.commit };
}

/** Whether the hot swap is on (the default): off only when BRAIN_MCP_HOT_SWAP=0 here or in the MCP entry Claude Code launches. */
async function hotSwapConfigured(): Promise<boolean> {
  if (process.env.BRAIN_MCP_HOT_SWAP === "0") return false;
  try {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { readFile } = await import("node:fs/promises");
    const config = JSON.parse(await readFile(join(homedir(), ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    };
    return config.mcpServers?.["project-brain"]?.env?.BRAIN_MCP_HOT_SWAP !== "0";
  } catch {
    return true;
  }
}

async function defaultClaim(sessionId: string, kind: "clear" | "compact"): Promise<boolean> {
  const { DATA_DIR } = await import("../constants.js");
  const { claimNotice } = await import("../hooks/task-switch.js");
  return claimNotice(DATA_DIR, sessionId, kind);
}

/** Never throws: no context means no task-switch question and no extra output. */
async function taskContextFor(input: HookInput, deps: SuggestDeps) {
  try {
    if (deps.taskContext) return await deps.taskContext(input);
    const { gatherTaskContext } = await import("../hooks/task-switch.js");
    return await gatherTaskContext(input.transcriptPath, input.prompt);
  } catch {
    return null;
  }
}

/**
 * The prompt vector, started only when the picker awaits it, i.e. after its token and picker-flag
 * checks, so a user without a token (or with both pickers off) never touches Ollama.
 */
function budgetedVector(
  prompt: string,
  projectDir: string,
  queryEmbedding: (prompt: string, projectDir: string) => Promise<SharedQuery | null>,
  embedBudgetMs: number
): () => Promise<SharedQuery | null> {
  let started: Promise<SharedQuery | null> | undefined;
  return () =>
    (started ??= new Promise<SharedQuery | null>((resolve) => {
      const done = (value: SharedQuery | null) => {
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), embedBudgetMs);
      queryEmbedding(prompt, projectDir).then(done, () => done(null));
    }));
}

export interface AgentSuggestDeps {
  print?: (text: string) => void;
  pick?: typeof pickSkill;
  queryEmbedding?: (prompt: string, projectDir: string) => Promise<SharedQuery | null>;
  embedBudgetMs?: number;
  recordHealth?: (ok: boolean) => Promise<unknown>;
}

export const DELEGATION_SKILLS_HEADING = "Skills for this task, picked for it (load one with the Skill tool when you reach the part it covers):";

/** What a delegation hands its subagent: `prompt`, its `description`, and the session's `cwd`. */
function parseAgentInput(raw: string): { text: string; cwd: string | undefined } {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const prompt = typeof obj.prompt === "string" ? obj.prompt : "";
    const description = typeof obj.description === "string" ? obj.description : "";
    return { text: [description, prompt].filter(Boolean).join("\n\n"), cwd: typeof obj.cwd === "string" && obj.cwd !== "" ? obj.cwd : undefined };
  } catch {
    return { text: "", cwd: undefined };
  }
}

/**
 * `suggest --agent --stdin`: the skills a delegated task needs, from the same one-request Jev pick
 * as the prompt hook, printed as a block the caller appends to the subagent's prompt. Prints
 * nothing when nothing was picked or anything failed, so the delegation goes out unchanged.
 */
export async function runAgentSuggest(raw: string, deps: AgentSuggestDeps = {}): Promise<void> {
  const { print = console.log, pick = pickSkill, queryEmbedding = sharedQueryFor, embedBudgetMs = EMBED_BUDGET_MS } = deps;
  try {
    const { text, cwd } = parseAgentInput(raw);
    if (!text.trim() || isTrivialPrompt(text)) return;
    const projectDir = cwd ?? process.cwd();
    const lines = await pick(text, {
      projectDir,
      queryEmbedding: budgetedVector(text, projectDir, queryEmbedding, embedBudgetMs),
      ...(deps.recordHealth ? { recordHealth: deps.recordHealth } : {}),
    });
    if (lines) print(`${DELEGATION_SKILLS_HEADING}\n${lines}`);
  } catch {
    // A delegation must never wait on, or break over, a suggestion.
  }
}

/**
 * The hook body: print the skill/tool suggestion lines for one prompt. Needs
 * neither an index nor retrieval, so it works in any directory. Never throws;
 * any failure prints nothing.
 */
export async function runSuggest(raw: string, deps: SuggestDeps = {}): Promise<void> {
  const { print = console.log, pick = pickSuggestions, queryEmbedding = sharedQueryFor, embedBudgetMs = EMBED_BUDGET_MS } = deps;
  try {
    const input = parseHookInput(raw);
    const { prompt, cwd } = input;

    // Held back so a task-switch notice can go out as one JSON document with everything else.
    const out: string[] = [];
    let commitNotice: (() => Promise<void>) | undefined;
    const flush = async (systemMessage: string | null): Promise<void> => {
      const additionalContext = out.join("\n");
      if (systemMessage === null) for (const line of out) print(line);
      else
        print(
          JSON.stringify({
            systemMessage,
            ...(additionalContext ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: fencedForGate(additionalContext) } } : {}),
          })
        );
      out.length = 0;
      // Marked only once printed: if the timeout wins first, the notice is still owed.
      const commit = commitNotice;
      commitNotice = undefined;
      await commit?.().catch(() => {});
    };

    // Independent of the pickers and of the prompt: it needs no token, no index and no embedding.
    try {
      const notice = await (deps.upgradeNotice ?? upgradeNoticeFor)(input);
      if (notice) {
        out.push(notice.text);
        commitNotice = notice.commit;
      }
    } catch {
      // A notice is a courtesy; it must never cost the suggestions.
    }

    if (!prompt.trim() || isTrivialPrompt(prompt)) return await flush(null);
    const projectDir = cwd ?? process.cwd();
    const vector = budgetedVector(prompt, projectDir, queryEmbedding, embedBudgetMs);

    const alreadyShown = import("../hooks/injected.js").then((m) => m.liveHookOutput(input.transcriptPath), () => null);
    const task = await taskContextFor(input, deps);
    // Nothing to wait for in the Jev round trip: print the notice now so a slow pick cannot cost it.
    if (!task) await flush(null);
    let switchProbabilities: Record<string, number> | undefined;
    const lines = await pick(prompt, {
      projectDir,
      queryEmbedding: vector,
      ...(deps.recordHealth ? { recordHealth: deps.recordHealth } : {}),
      ...(task ? { taskSwitch: { recent: task.recent, ...(task.assistant ? { assistant: task.assistant } : {}) }, onTaskSwitch: (p: Record<string, number>) => (switchProbabilities = p) } : {}),
    });
    const shown = await alreadyShown;
    for (const line of lines) if (line && !(shown && alreadySuggested(shown, line))) out.push(line);

    const { decideTaskSwitch, taskSwitchMessage } = await import("../hooks/task-switch.js");
    let message: string | null = null;
    if (task) {
      const verdict = decideTaskSwitch(task.usedPct, switchProbabilities, undefined, task.pending);
      const kind = verdict === "clear" ? "clear" : "compact";
      const first = verdict === "none" || !input.sessionId ? true : await (deps.claimNotice ?? defaultClaim)(input.sessionId, kind);
      message = first ? taskSwitchMessage(verdict, task.usedPct, prompt) : null;
    }
    await flush(message);
  } catch {
    // A suggestion hook must never disturb the prompt.
  }
}

async function recordPickHealthInDataDir(ok: boolean): Promise<void> {
  const { DATA_DIR } = await import("../constants.js");
  const { recordPickHealth } = await import("../skills/listed.js");
  await recordPickHealth(DATA_DIR, ok);
}

export async function runContextSuggest(raw: string, deps: { print?: (text: string) => void } & ContextJudgeDeps = {}): Promise<void> {
  const { print = console.log, ...judgeDeps } = deps;
  try {
    const input = parseContextInput(raw);
    if (!input) return;
    const verdict = await judgeContext(input, judgeDeps);
    if (verdict) print(JSON.stringify(verdict));
  } catch {
    return;
  }
}

async function recordContextHealthInDataDir(ok: boolean): Promise<void> {
  const { DATA_DIR } = await import("../constants.js");
  await recordContextGateHealth(DATA_DIR, ok);
}

export const CONTEXT_TIMEOUT_MS = 2500;

/**
 * CLI entry point: `project-brain suggest --stdin` (the prompt hook), `suggest --agent --stdin`
 * (a delegation's skills) or `suggest --context --stdin` (the context gate). Without `--stdin` it does nothing.
 */
export async function execute(
  args: string[],
  readStdin: () => Promise<string> = () => Bun.stdin.text(),
  deps: SuggestDeps = {}
): Promise<void> {
  if (!args.includes("--stdin")) return;
  const context = args.includes("--context");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, context ? CONTEXT_TIMEOUT_MS : SUGGEST_TIMEOUT_MS);
  });
  const recordHealth = deps.recordHealth ?? recordPickHealthInDataDir;
  const run = context
    ? (raw: string) => runContextSuggest(raw, { recordHealth: deps.recordHealth ?? recordContextHealthInDataDir })
    : args.includes("--agent")
      ? (raw: string) => runAgentSuggest(raw, { recordHealth })
      : (raw: string) => runSuggest(raw, { ...deps, recordHealth });
  const work = readStdin().then(run, () => {});
  await Promise.race([work, timeout]);
  clearTimeout(timer);
}
