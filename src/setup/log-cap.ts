import { homedir } from "node:os";
import { join } from "node:path";
import { open, stat, truncate, writeFile } from "node:fs/promises";

/** The interactive Ollama's service log, under DATA_DIR. */
export const INTERACTIVE_LOG_FILE = "ollama-interactive.log";

/**
 * Ollama's llama-server runner logs several INFO lines per request — slot
 * selection, prompt cache, release — whatever OLLAMA_DEBUG says, and ollama
 * passes it a fixed `--log-verbosity`. Under steady embedding that grew the
 * Homebrew service log to 1.3 GB. Neither launchd nor a `StandardOutput=append:`
 * systemd unit rotates, so the service log project-brain installs is capped
 * from here instead.
 */
export const LOG_CAP_BYTES = 50 * 1024 ** 2;
/** Above this, `health` points at the default Ollama's log, which project-brain does not own. */
export const OLLAMA_LOG_HINT_BYTES = 500 * 1024 ** 2;

export interface CapResult {
  trimmed: boolean;
  bytes: number;
}

/**
 * Keep one rotation: the newest `maxBytes` move to `<path>.1`, and the live
 * file is truncated in place. Truncating rather than renaming matters — the
 * service manager holds the file open in append mode, so a renamed file would
 * keep growing under its new name while the original path stayed empty.
 */
export async function capLogFile(path: string, maxBytes: number = LOG_CAP_BYTES): Promise<CapResult> {
  const size = await stat(path).then((s) => s.size, () => null);
  if (size === null || size <= maxBytes) return { trimmed: false, bytes: size ?? 0 };

  const handle = await open(path, "r");
  try {
    const tail = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(tail, 0, maxBytes, size - maxBytes);
    await writeFile(`${path}.1`, tail.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
  await truncate(path, 0);
  return { trimmed: true, bytes: size };
}

/** Where the default Ollama writes its log, by install method. */
export function defaultOllamaLogPaths(home: string = homedir()): string[] {
  return [
    "/opt/homebrew/var/log/ollama.log",
    "/usr/local/var/log/ollama.log",
    join(home, ".ollama", "logs", "server.log"),
  ];
}

export interface OversizedLog {
  path: string;
  bytes: number;
}

export async function findOversizedOllamaLog(
  paths: string[] = defaultOllamaLogPaths(),
  thresholdBytes: number = OLLAMA_LOG_HINT_BYTES
): Promise<OversizedLog | null> {
  for (const path of paths) {
    const bytes = await stat(path).then((s) => s.size, () => 0);
    if (bytes > thresholdBytes) return { path, bytes };
  }
  return null;
}

function shellQuote(path: string): string {
  return /^[\w./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The hint names the exact command and leaves running it to the owner. */
export function formatOllamaLogHint(log: OversizedLog): string {
  const size = log.bytes >= 1024 ** 3 ? `${(log.bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(log.bytes / 1024 ** 2)} MB`;
  return `⚠ Ollama's log is ${size} (${log.path}) — trim it in place with: : > ${shellQuote(log.path)}`;
}
