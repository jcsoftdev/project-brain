// REGRESSION GUARD — the structural layer's WASM grammars + SQLite schema must be
// EMBEDDED into the `bun build --compile` binary (the artifact release.yml ships to npm).
//
// History: every other test passed while the shipped binary was fully broken, because
// `bun test` runs from the project root where node_modules + schema.sql exist on disk.
// require.resolve(".wasm") and readFileSync("schema.sql") resolved fine in dev but blew
// up at runtime in the compiled binary with `ENOENT '/$bunfs/root/...'`, crashing the
// whole indexer. See structural-layer/publish-blocker-wasm.
//
// This test compiles a harness that drives the REAL runSync over a temp project and runs
// the binary with cwd OUTSIDE the repo (no node_modules) — the only way to catch the gap.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = resolve(import.meta.dir, "../..");
let work: string;
let binPath: string;
let compiled = false;
let buildStderr = "";

const HARNESS = `
import { runSync } from "${REPO}/src/commands/sync.js";
import { openGraphDb } from "${REPO}/src/graph/db.js";
import { GraphStore } from "${REPO}/src/graph/store.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pb-cbin-"));
mkdirSync(join(dir, ".project-brain"), { recursive: true });
writeFileSync(join(dir, "a.ts"), "export function add(a,b){ return helper(a,b); }\\nfunction helper(a,b){ return a+b; }");
const noop = { embed: async (t) => t.map(() => new Array(8).fill(0)), isAvailable: async () => true };
const store = { ensureTable: async()=>{}, upsert: async()=>{}, search: async()=>[], deleteBySource: async()=>{}, listModules: async()=>[], getModuleChunks: async()=>[], countChunks: async()=>0, optimize: async()=>{}, batchReplace: async()=>{}, buildIndexes: async()=>{}, hybridSearch: async()=>[], getChunkById: async()=>null, assertDim: async()=>{} };
await runSync({ root: dir, projectId: "cbin", store, embeddings: noop });
const db = openGraphDb(join(dir, ".project-brain", "graph.db"));
const gs = new GraphStore(db);
const sym = gs.findSymbol("add");
const callees = gs.findCallees("add").map((h) => h.name);
db.close();
if (sym.length > 0 && callees.includes("helper")) console.log("STRUCT_OK");
else console.log("STRUCT_FAIL", JSON.stringify({ sym: sym.length, callees }));
`;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "pb-compile-"));
  const harnessPath = join(work, "harness.ts");
  binPath = join(work, "struct-bin");
  writeFileSync(harnessPath, HARNESS);
  // Compile with the SAME mechanism release.yml uses for the host platform.
  const build = spawnSync(
    "bun",
    ["build", harnessPath, "--compile", "--outfile", binPath],
    { cwd: REPO, encoding: "utf8" }
  );
  compiled = build.status === 0;
  if (!compiled) {
    // The test env always has bun, so a build failure is a real regression —
    // surface it loudly instead of silently passing (the exact blind spot that
    // shipped the original broken binary).
    buildStderr = build.stderr ?? "";
  }
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

test("compiled binary embeds WASM grammars + SQLite schema and extracts structure outside node_modules", () => {
  // The test env always has bun — a build failure is a real regression, not an
  // excuse to skip. Fail loudly with the build stderr so the gap is visible.
  expect(compiled, `bun build --compile failed:\n${buildStderr}`).toBe(true);
  // Run from a scratch dir with NO node_modules and NO schema.sql on disk.
  const scratch = mkdtempSync(join(tmpdir(), "pb-scratch-"));
  const run = spawnSync(binPath, [], { cwd: scratch, encoding: "utf8" });
  rmSync(scratch, { recursive: true, force: true });

  // The pre-fix failure mode was a non-zero exit with `ENOENT '/$bunfs/root/...'`.
  expect(run.stderr ?? "").not.toContain("ENOENT");
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("STRUCT_OK");
});
