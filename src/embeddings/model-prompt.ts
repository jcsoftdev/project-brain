import { emitKeypressEvents, moveCursor, cursorTo, clearScreenDown } from "node:readline";
import type { Key } from "node:readline";

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

/**
 * Real-terminal picker: highlight one menu item at a time, move the
 * highlight with the up/down arrows (or j/k), confirm with Enter. Renders
 * its own lines instead of going through the generic `ask(question)` string
 * prompt, since it needs to redraw in place on every keypress. Only used
 * when the caller hasn't injected a custom `ask` (i.e. real usage, never
 * tests — see promptEmbedModel below).
 */
function interactiveMenuSelect(defaultIndex: number, currentModel?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let index = defaultIndex;

    const lines = () => [
      "Which embedding model should project-brain use?",
      ...MENU.map((m, i) => `  ${i === index ? "❯" : " "} ${m.label}`),
      currentModel ? `Currently: ${currentModel}` : null,
      "(↑/↓ to move, Enter to select)",
    ].filter((line): line is string => line !== null);

    let rendered = 0;
    const render = () => {
      if (rendered > 0) {
        moveCursor(process.stdout, 0, -rendered);
        cursorTo(process.stdout, 0);
        clearScreenDown(process.stdout);
      }
      const out = lines();
      process.stdout.write(out.join("\n") + "\n");
      rendered = out.length;
    };

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    emitKeypressEvents(stdin);
    stdin.setRawMode?.(true);
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener("keypress", onKeypress);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
    };

    const onKeypress = (_str: string, key: Key) => {
      if (key.name === "up" || key.name === "k") {
        index = (index - 1 + MENU.length) % MENU.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        index = (index + 1) % MENU.length;
        render();
      } else if (key.name === "return") {
        cleanup();
        resolve(MENU[index].num);
      } else if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("aborted"));
      }
    };

    stdin.on("keypress", onKeypress);
    render();
  });
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

  const defaultChoice = defaultChoiceFor(options);

  // Real terminal usage (no injected `ask`): arrow-key picker, can't produce
  // an invalid answer, so there's no re-prompt path to worry about.
  if (!options.ask) {
    const defaultIndex = MENU.findIndex((m) => m.num === defaultChoice);
    const num = await interactiveMenuSelect(defaultIndex, options.currentModel);
    return keyFor(num)!;
  }

  // Test-injected `ask`: keep the old text-based numeric-answer contract.
  const ask = options.ask;
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
