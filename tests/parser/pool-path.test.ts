import { test, expect } from "bun:test";
import { workerEntryCandidates, resolveWorkerEntry } from "../../src/parser/pool.js";

// Regression coverage for the Windows release blocker.
//
// FINDING #1 (v0.7.0 — 3 failed releases on windows-x64 AND windows-arm64):
//   worker error: BuildMessage: ModuleNotFound resolving
//   "B:\~BUN\root\worker.js" (entry point)
// Root cause: the old detection (`import.meta.url.includes("/$bunfs/") ||
// import.meta.url.includes("/~BUN/")`) required POSIX slashes around the
// compiled-binary marker. On Windows, Bun mounts the embedded FS at
// `B:\~BUN\...` — backslashes, no leading/trailing slash around `~BUN` in
// the way the old check assumed — so IS_COMPILED was false and the dev
// (sibling `./worker.js`) path was chosen instead of the assumed bundled
// location `<root>\parser\worker.js`. Fixed in 4d9e00b (separator-agnostic
// detection).
//
// FINDING #2 (STILL FAILING after #1, workflow_dispatch @ 2661f73, real
// Windows runners):
//   worker error: BuildMessage: ModuleNotFound resolving
//   "B:\~BUN\root\worker.js" (entry point)
// Byte-identical error, and critically: NO `parser\` segment in the
// reported path — inconsistent with the "compiled → parser/worker.js"
// layout finding #1 assumed to be universal. Root cause among (a) real
// Windows import.meta.url shape differs from assumed, (b) `--compile`
// flattening lands worker.js at a different path on Windows, (c) Bun's
// Worker constructor resolves differently — is UNKNOWN; no Windows machine
// available to observe directly. Resolution is therefore candidate-based:
// try plausible layouts in order at runtime instead of asserting one.

test("dev POSIX base: single candidate, sibling ./worker.js (dev semantics preserved)", () => {
  const result = workerEntryCandidates("file:///Users/x/project/src/parser/pool.ts");
  expect(result).toEqual(["file:///Users/x/project/src/parser/worker.js"]);
});

test("compiled POSIX base ($bunfs): two candidates, parser/worker.js first then flat worker.js", () => {
  const result = workerEntryCandidates("file:///$bunfs/root/cli");
  expect(result).toEqual([
    "file:///$bunfs/root/parser/worker.js",
    "file:///$bunfs/root/worker.js",
  ]);
});

test("compiled Windows URL-form base (file:///B:/~BUN/...): two candidates, forward-slash form", () => {
  const result = workerEntryCandidates("file:///B:/~BUN/root/cli.exe");
  expect(result).toEqual([
    "file:///B:/~BUN/root/parser/worker.js",
    "file:///B:/~BUN/root/worker.js",
  ]);
});

test("compiled Windows raw-path base (B:\\~BUN\\...): two candidates, backslash form preserved", () => {
  const result = workerEntryCandidates("B:\\~BUN\\root\\cli.exe");
  expect(result).toEqual([
    "B:\\~BUN\\root\\parser\\worker.js",
    "B:\\~BUN\\root\\worker.js",
  ]);
});

test("compiled Windows URL-encoded base (%5C separators): two candidates, both best-effort collapsed", () => {
  const result = workerEntryCandidates("file:///B:%5C~BUN%5Croot%5Ccli.exe");
  expect(result.length).toBe(2);
  // The URL API collapses the whole percent-encoded path (no literal "/" to
  // split the last segment on) — both candidates fall back to a bare
  // `file:///<relPath>` rather than preserving the drive/root structure.
  expect(result[0]).toBe("file:///parser/worker.js");
  expect(result[1]).toBe("file:///worker.js");
});

test("first candidate is always the historically-verified layout (parser/worker.js) when compiled", () => {
  const posix = workerEntryCandidates("file:///$bunfs/root/cli");
  const winUrl = workerEntryCandidates("file:///B:/~BUN/root/cli.exe");
  expect(posix[0]).toContain("parser/worker.js");
  expect(winUrl[0]).toContain("parser/worker.js");
});

// resolveWorkerEntry is kept only as a thin compatibility shim (first
// candidate of workerEntryCandidates) for any external caller still using
// the old single-path name — verify it stays in sync rather than drifting.
test("resolveWorkerEntry (compat shim) returns the first workerEntryCandidates entry", () => {
  const bases = [
    "file:///Users/x/project/src/parser/pool.ts",
    "file:///$bunfs/root/cli",
    "file:///B:/~BUN/root/cli.exe",
    "B:\\~BUN\\root\\cli.exe",
  ];
  for (const base of bases) {
    expect(resolveWorkerEntry(base)).toBe(workerEntryCandidates(base)[0]);
  }
});
