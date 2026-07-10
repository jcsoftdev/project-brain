import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runParseSelfTest, runPoolSelfTest } from "../../src/commands/parse-selftest";
import { poolDiagnostics } from "../../src/parser/pool.js";

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

// --pool exercises the worker-pool path (src/parser/pool.ts's candidate-based
// resolver) instead of the in-process sequential parser — see pool.ts's doc
// comment for why (Windows release blocker, 2 confirmed failed hypotheses).
test("runPoolSelfTest returns a nonzero symbol count via the real worker pool (dev candidates)", async () => {
  const count = await runPoolSelfTest();
  expect(count).toBeGreaterThanOrEqual(1);
});

// DIAG output (execute()'s --pool branch) reads these two fields — verify
// the helper the CLI depends on actually exposes them correctly, so a
// future refactor of pool.ts can't silently break the diagnostics without
// a test noticing.
test("poolDiagnostics exposes pool.ts's own import.meta.url and its derived candidate list", () => {
  const { importMetaUrl, candidates } = poolDiagnostics();
  expect(importMetaUrl).toContain("src/parser/pool.ts");
  expect(candidates.length).toBeGreaterThanOrEqual(1);
  expect(candidates[0]).toContain("worker.js");
});
