import { createInterface } from "node:readline/promises";

export interface PromptEmbedModelOptions {
  /** Whether Ollama responded to a quick probe — drives the default choice when no current model is stored. */
  ollamaAvailable: boolean;
  /** The project's currently stored model (reindex path). Undefined on first init. */
  currentModel?: string;
  /** Injectable for tests — defaults to a real stdin/stdout readline prompt. */
  ask?: (question: string) => Promise<string>;
}

const MENU = [
  { num: "1", key: "qwen3-embedding", label: "qwen3-embedding:0.6b  (recommended, code-capable)" },
  { num: "2", key: "nomic-text", label: "nomic-embed-text      (lighter, 768-dim)" },
  { num: "3", key: "none", label: "No embeddings — keyword search only (no Ollama needed)" },
] as const;

function keyFor(num: string): string | undefined {
  return MENU.find((m) => m.num === num)?.key;
}

function defaultChoiceFor(opts: { ollamaAvailable: boolean; currentModel?: string }): string {
  if (opts.currentModel === "qwen3-embedding:0.6b") return "1";
  if (opts.currentModel === "nomic-embed-text") return "2";
  if (opts.currentModel === "none") return "3";
  return opts.ollamaAvailable ? "1" : "3";
}

async function realAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Interactively ask which embedding model to use (init/reindex only —
 * NEVER call this from sync, which runs unattended via git hooks/watcher).
 * Returns the chosen registry key, or null when the prompt is skipped:
 * non-TTY stdin, or BRAIN_EMBED_MODEL is already set (explicit env/flag
 * always wins, matching every other model-resolution path in this codebase).
 */
export async function promptEmbedModel(options: PromptEmbedModelOptions): Promise<string | null> {
  if (process.env.BRAIN_EMBED_MODEL) return null;
  if (!process.stdin.isTTY) return null;

  const ask = options.ask ?? realAsk;
  const defaultChoice = defaultChoiceFor(options);
  const menuText = [
    "Which embedding model should project-brain use?",
    ...MENU.map((m) => `  ${m.num}) ${m.label}`),
    options.currentModel ? `Currently: ${options.currentModel}` : null,
    `Select [1-3] (default: ${defaultChoice}): `,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  let answer = (await ask(menuText)).trim();
  if (answer === "") return keyFor(defaultChoice)!;
  if (keyFor(answer)) return keyFor(answer)!;

  // One re-prompt on invalid input, then fall back to the default.
  answer = (await ask(`Please enter 1, 2, or 3 (default: ${defaultChoice}): `)).trim();
  if (answer === "") return keyFor(defaultChoice)!;
  return keyFor(answer) ?? keyFor(defaultChoice)!;
}

/** Quick, short-timeout probe — used only to pick the interactive prompt's default choice. */
export async function isOllamaAvailable(): Promise<boolean> {
  const { OLLAMA_HOST } = await import("../constants.js");
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(1_000) });
    return res.ok;
  } catch {
    return false;
  }
}
