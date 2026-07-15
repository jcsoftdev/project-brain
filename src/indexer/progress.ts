import type { SyncProgress } from "../commands/sync.js";

/**
 * Format an elapsed-time span (ms) for CLI display.
 *   - < 10s: one decimal place, e.g. "8.3s" (sub-10s precision matters on
 *     small/incremental syncs where the whole run can finish in a couple
 *     seconds).
 *   - 10s-59999ms: whole seconds, floored — e.g. "42s" (avoids the
 *     ugly/misleading "60s" that Math.round would produce for 59500-59999ms).
 *   - >= 60000ms: "Nm Ss" — minutes + floored remainder seconds, e.g.
 *     "1m 42s", "12m 5s" (no zero-padding needed).
 */
export function formatDuration(ms: number): string {
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/** Human-readable label for the `Model:` line in sync/reindex CLI output. */
export function formatModelLabel(model: string | undefined): string {
  if (model === "none") return "none (lexical-only — keyword search only)";
  return model ?? "unknown";
}

export function makeProgressPrinter() {
  const isTTY = process.stdout.isTTY;
  const clear = () => isTTY && process.stdout.write("\r\x1b[K");
  const print = (msg: string) => {
    clear();
    if (isTTY) process.stdout.write(msg);
    else console.log(msg);
  };

  function onProgress({ phase, current, total }: SyncProgress) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    const filled = Math.floor(pct / 5);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);
    switch (phase) {
      case "scanning":
        print(total === 0 ? `  Scanning files...` : `  Scanned  ${current} files`);
        break;
      case "reading":
        print(`  Reading   [${bar}] ${pct}%  ${current}/${total} files`);
        break;
      case "embedding":
        print(`  Embedding [${bar}] ${pct}%  ${current}/${total} chunks`);
        break;
      case "storing":
        print(`  Indexing  ✓ ${current} files indexed`);
        break;
    }
  }

  return { onProgress, clear };
}
