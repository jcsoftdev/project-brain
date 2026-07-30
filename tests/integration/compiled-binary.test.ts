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

// Same class of bug, second surface: the brain-audit skill templates must be
// EMBEDDED via `with { type: "text" }`, not read from templates/ at runtime.
// 56af699 already fixed this for rules.claude.md / project.claude.md /
// model-routing.claude.md; the original brain-audit design proposed a recursive
// `cp` from import.meta.dir, which would have reintroduced it. Under
// --compile, import.meta.dir is a virtual /$bunfs path with no traversal back
// to a real templates/ directory, so every read fails with ENOENT.
const SKILL_HARNESS = `
import { installSkill, SKILL_MANIFESTS } from "${REPO}/src/rules/skills.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pb-skill-cbin-"));
const { written, skipped } = await installSkill([dir]);

// Every embedded file of every registered skill must survive the compile AND
// land non-empty on disk. Nothing here is hardcoded to a count or a skill name:
// adding a skill or a reference file keeps this assertion honest by itself.
let missing = [];
let nested = 0;
for (const [name, manifest] of Object.entries(SKILL_MANIFESTS)) {
  for (const [rel, content] of Object.entries(manifest)) {
    if (rel.includes("/")) nested++;
    let onDisk = "";
    try { onDisk = readFileSync(join(dir, name, rel), "utf8"); } catch (e) { missing.push(name + "/" + rel + ":throw"); continue; }
    if (onDisk.length === 0 || onDisk !== content) missing.push(name + "/" + rel);
  }
}

const skillNames = Object.keys(SKILL_MANIFESTS);
const ok =
  written.length === skillNames.length &&
  skipped.length === 0 &&
  missing.length === 0 &&
  nested > 0 &&
  skillNames.every((n) => SKILL_MANIFESTS[n]["SKILL.md"].includes("name: " + n));

if (ok) console.log("SKILL_OK");
else console.log("SKILL_FAIL", JSON.stringify({ written, skipped, missing, nested, skills: skillNames }));
`;

let skillBinPath: string;
let skillCompiled = false;
let skillBuildStderr = "";

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

  const skillHarnessPath = join(work, "skill-harness.ts");
  skillBinPath = join(work, "skill-bin");
  writeFileSync(skillHarnessPath, SKILL_HARNESS);
  const skillBuild = spawnSync(
    "bun",
    ["build", skillHarnessPath, "--compile", "--outfile", skillBinPath],
    { cwd: REPO, encoding: "utf8" }
  );
  skillCompiled = skillBuild.status === 0;
  if (!skillCompiled) skillBuildStderr = skillBuild.stderr ?? "";
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

test("compiled binary embeds every brain-audit skill template and installs them outside the repo", () => {
  expect(skillCompiled, `bun build --compile failed:\n${skillBuildStderr}`).toBe(true);
  // cwd outside the repo: no templates/ directory anywhere up the tree, so a
  // runtime filesystem read has nothing to find and must fail here if present.
  const scratch = mkdtempSync(join(tmpdir(), "pb-skill-scratch-"));
  const run = spawnSync(skillBinPath, [], { cwd: scratch, encoding: "utf8" });
  rmSync(scratch, { recursive: true, force: true });

  expect(run.stderr ?? "").not.toContain("ENOENT");
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("SKILL_OK");
});
