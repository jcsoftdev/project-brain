import { isTrivialPrompt } from "./trivial-prompt.js";
import { pickSuggestions } from "../skills/picker.js";
import type { SharedQuery } from "../skills/semantic.js";

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
}

/** `prompt` and `cwd` from the UserPromptSubmit JSON; empty/undefined on any malformed input. Never throws. */
export function parseHookInput(raw: string): HookInput {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { prompt: "", cwd: undefined };
    const obj = parsed as Record<string, unknown>;
    return {
      prompt: typeof obj.prompt === "string" ? obj.prompt : "",
      cwd: typeof obj.cwd === "string" && obj.cwd !== "" ? obj.cwd : undefined,
    };
  } catch {
    return { prompt: "", cwd: undefined };
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
}

/**
 * The hook body: print the skill/tool suggestion lines for one prompt. Needs
 * neither an index nor retrieval, so it works in any directory. Never throws;
 * any failure prints nothing.
 */
export async function runSuggest(raw: string, deps: SuggestDeps = {}): Promise<void> {
  const { print = console.log, pick = pickSuggestions, queryEmbedding = sharedQueryFor, embedBudgetMs = EMBED_BUDGET_MS } = deps;
  try {
    const { prompt, cwd } = parseHookInput(raw);
    if (!prompt.trim() || isTrivialPrompt(prompt)) return;
    const projectDir = cwd ?? process.cwd();

    // Started only when the picker awaits it, i.e. after its token and picker-flag checks, so a
    // user without a token (or with both pickers off) never touches Ollama.
    let started: Promise<SharedQuery | null> | undefined;
    const vector = (): Promise<SharedQuery | null> =>
      (started ??= new Promise<SharedQuery | null>((resolve) => {
        const done = (value: SharedQuery | null) => {
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => done(null), embedBudgetMs);
        queryEmbedding(prompt, projectDir).then(done, () => done(null));
      }));

    const lines = await pick(prompt, { projectDir, queryEmbedding: vector });
    for (const line of lines) if (line) print(line);
  } catch {
    // A suggestion hook must never disturb the prompt.
  }
}

/** CLI entry point: `project-brain suggest --stdin`. Without `--stdin` it does nothing. */
export async function execute(
  args: string[],
  readStdin: () => Promise<string> = () => Bun.stdin.text(),
  deps: SuggestDeps = {}
): Promise<void> {
  if (!args.includes("--stdin")) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SUGGEST_TIMEOUT_MS);
  });
  const work = readStdin().then((raw) => runSuggest(raw, deps), () => {});
  await Promise.race([work, timeout]);
  clearTimeout(timer);
}
