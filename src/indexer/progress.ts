import type { SyncProgress } from "../commands/sync.js";

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
        // total is unknown until all waves are read — show running counter only
        print(`  Indexing  ✓ ${current} files indexed`);
        break;
    }
  }

  return { onProgress, clear };
}
