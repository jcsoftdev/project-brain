import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runParseSelfTest } from "../../src/commands/parse-selftest";

// FIX E: the build-smoke hook must produce a nonzero symbol count for a real
// .ts file using only the embedded parser (no Ollama, store, or graph DB).
test("runParseSelfTest returns a nonzero symbol count for a sample .ts file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pb-selftest-"));
  const file = join(dir, "a.ts");
  await writeFile(file, "export function smoke(a, b){ return a + b; }\n");

  try {
    const count = await runParseSelfTest(file);
    expect(count).toBeGreaterThanOrEqual(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
