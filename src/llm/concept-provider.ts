import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CONCEPT_LLM_MODEL, DATA_DIR, OLLAMA_HOST } from "../constants.js";
import { writeFileAtomic } from "../atomic-write.js";
import { LlmUnavailableError, type LlmClient } from "./client.js";

export const CONCEPT_PROVIDERS = ["anthropic", "ollama", "claude-code"] as const;
export type ConceptProvider = (typeof CONCEPT_PROVIDERS)[number];

export const CONCEPT_PROVIDER_ENV = "BRAIN_CONCEPT_PROVIDER";
export const CONCEPT_MODEL_ENV = "BRAIN_CONCEPT_MODEL";

export const DEFAULT_CONCEPT_PROVIDER: ConceptProvider = "anthropic";

export const DEFAULT_CONCEPT_MODELS: Record<ConceptProvider, string> = {
  anthropic: CONCEPT_LLM_MODEL,
  ollama: "qwen3.5:4b",
  "claude-code": "haiku",
};

/** What leaves the machine, per backend — shared by setup's wording and the docs. */
export const CONCEPT_PROVIDER_DISCLOSURE: Record<ConceptProvider, string> = {
  anthropic: "the Anthropic API, with Anthropic credentials",
  ollama: "nothing — the local Ollama writes it",
  "claude-code": "Anthropic, through your Claude Code login (`claude -p`, haiku), on your subscription quota",
};

export interface ConceptConfig {
  provider?: ConceptProvider;
  model?: string;
}

/**
 * Its own file rather than a key in `ollama.json`: that file configures the
 * embedding lanes, and two of the three backends have nothing to do with Ollama.
 */
export const conceptConfigPath = (dataDir: string = DATA_DIR): string => join(dataDir, "concept.json");

export function isConceptProvider(value: unknown): value is ConceptProvider {
  return typeof value === "string" && (CONCEPT_PROVIDERS as readonly string[]).includes(value);
}

export function readConceptConfig(dataDir: string = DATA_DIR): ConceptConfig | null {
  try {
    const raw = JSON.parse(readFileSync(conceptConfigPath(dataDir), "utf8")) as Record<string, unknown>;
    const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;
    return { provider: isConceptProvider(raw.provider) ? raw.provider : undefined, model };
  } catch {
    return null;
  }
}

export async function writeConceptConfig(dataDir: string, config: ConceptConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFileAtomic(conceptConfigPath(dataDir), `${JSON.stringify(config, null, 2)}\n`);
}

export interface ConceptSettings {
  provider: ConceptProvider;
  model: string;
  /** An env value that named no known provider and was passed over. */
  ignoredProvider?: string;
}

/**
 * Provider: `BRAIN_CONCEPT_PROVIDER`, then `concept.json`, then anthropic.
 * Model: `BRAIN_CONCEPT_MODEL`, then the file's model, then the provider's default.
 * The file's model belongs to the file's provider, so an env override of the
 * provider never inherits it — an ollama tag handed to `claude --model` fails.
 */
export function resolveConceptSettings(
  opts: { env?: Record<string, string | undefined>; dataDir?: string } = {}
): ConceptSettings {
  const env = opts.env ?? process.env;
  const config = readConceptConfig(opts.dataDir ?? DATA_DIR);
  const rawEnv = env[CONCEPT_PROVIDER_ENV]?.trim().toLowerCase();
  const envProvider = isConceptProvider(rawEnv) ? rawEnv : undefined;
  const provider = envProvider ?? config?.provider ?? DEFAULT_CONCEPT_PROVIDER;
  const configModel = config && (config.provider ?? DEFAULT_CONCEPT_PROVIDER) === provider ? config.model : undefined;
  const model = env[CONCEPT_MODEL_ENV]?.trim() || configModel || DEFAULT_CONCEPT_MODELS[provider];
  return { provider, model, ...(rawEnv && !envProvider ? { ignoredProvider: rawEnv } : {}) };
}

export async function createConceptLlm(settings: ConceptSettings): Promise<LlmClient> {
  switch (settings.provider) {
    case "ollama": {
      const { createOllamaClient } = await import("./ollama-client.js");
      return createOllamaClient({ model: settings.model, host: OLLAMA_HOST });
    }
    case "claude-code": {
      const { createClaudeCodeClient } = await import("./claude-code-client.js");
      return createClaudeCodeClient({ model: settings.model });
    }
    case "anthropic": {
      const { createAnthropicClient } = await import("./anthropic-client.js");
      return createAnthropicClient(settings.model);
    }
  }
}

/** Longest a hook-run conceptualize waits, in total, for embeds to finish before skipping. */
export const EMBED_YIELD_BUDGET_MS = 30_000;
const EMBED_YIELD_POLL_MS = 2_000;

export interface YieldToEmbedsOptions {
  /** Resolves the live embed-lock holder's pid, or null when nobody is embedding. */
  embedHolder: () => Promise<number | null>;
  budgetMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Lets sync's embeds go first on a shared Ollama, without holding the embed lock.
 *
 * Holding it would make every other worktree's hook sync queue behind minutes of
 * generation, and the holder must then drain their queued syncs — a job for
 * sync, not for a docs writer. So before each call this waits while someone is
 * embedding, against one small budget for the whole run; past it, the remaining
 * modules are skipped and picked up by the module's next commit.
 */
export function yieldToEmbeds(llm: LlmClient, opts: YieldToEmbedsOptions): LlmClient {
  const budgetMs = opts.budgetMs ?? EMBED_YIELD_BUDGET_MS;
  const pollMs = opts.pollMs ?? EMBED_YIELD_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  let waited = 0;

  return {
    async complete(prompt: string): Promise<string> {
      for (;;) {
        const holder = await opts.embedHolder();
        if (holder === null) return llm.complete(prompt);
        if (waited >= budgetMs) {
          throw new LlmUnavailableError(
            `Ollama is busy embedding (pid ${holder}) past the ${Math.round(budgetMs / 1000)}s wait`
          );
        }
        const step = Math.min(pollMs, budgetMs - waited);
        const started = now();
        await sleep(step);
        waited += Math.max(step, now() - started);
      }
    },
  };
}

/** The embed lock's live holder, or null. A record left by a dead process is nobody. */
export async function liveEmbedHolder(dataDir: string = DATA_DIR): Promise<number | null> {
  const { readEmbedLockHolder } = await import("../commands/embed-lock.js");
  const { defaultIsAlive } = await import("../commands/sync-lock.js");
  const holder = await readEmbedLockHolder(dataDir);
  return holder && defaultIsAlive(holder.pid) ? holder.pid : null;
}
