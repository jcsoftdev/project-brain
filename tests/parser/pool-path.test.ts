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

// FINDING #4 (oven-sh/bun#15981, #16869, #29124 — see pool.ts's doc comment):
// #16869 confirms, for the IDENTICAL Windows compiled-worker error, that
// passing a PLAIN RELATIVE STRING to `new Worker()` works while a
// `new URL(..., import.meta.url)`/`.href` form breaks in compiled Windows
// binaries. #29124 additionally flags nested subdirectory worker paths as
// separately broken (flat paths at the binary root work; nested ones may
// not) — hence both a nested and a flat plain-string candidate, in both
// `.js` and `.ts` extension forms, tried BEFORE the URL-resolved forms
// (which are now last-resort fallback, kept for layouts where the plain
// string doesn't apply).
const PLAIN_STRING_CANDIDATES = [
  "./parser/worker.js",
  "./worker.js",
  "./parser/worker.ts",
  "./worker.ts",
];

test("compiled POSIX base ($bunfs): plain-string candidates first, then URL-resolved parser/worker.js, then flat worker.js", () => {
  const result = workerEntryCandidates("file:///$bunfs/root/cli");
  expect(result).toEqual([
    ...PLAIN_STRING_CANDIDATES,
    "file:///$bunfs/root/parser/worker.js",
    "file:///$bunfs/root/worker.js",
  ]);
});

test("compiled Windows URL-form base (file:///B:/~BUN/...): plain-string candidates first, then URL-resolved forward-slash forms", () => {
  const result = workerEntryCandidates("file:///B:/~BUN/root/cli.exe");
  expect(result).toEqual([
    ...PLAIN_STRING_CANDIDATES,
    "file:///B:/~BUN/root/parser/worker.js",
    "file:///B:/~BUN/root/worker.js",
  ]);
});

test("compiled Windows raw-path base (B:\\~BUN\\...): plain-string candidates first, then URL-resolved backslash forms preserved", () => {
  const result = workerEntryCandidates("B:\\~BUN\\root\\cli.exe");
  expect(result).toEqual([
    ...PLAIN_STRING_CANDIDATES,
    "B:\\~BUN\\root\\parser\\worker.js",
    "B:\\~BUN\\root\\worker.js",
  ]);
});

test("compiled Windows URL-encoded base (%5C separators): plain-string candidates first, then both URL-resolved forms best-effort collapsed", () => {
  const result = workerEntryCandidates("file:///B:%5C~BUN%5Croot%5Ccli.exe");
  expect(result.length).toBe(6);
  expect(result.slice(0, 4)).toEqual(PLAIN_STRING_CANDIDATES);
  // The URL API collapses the whole percent-encoded path (no literal "/" to
  // split the last segment on) — both URL-resolved candidates fall back to a
  // bare `file:///<relPath>` rather than preserving the drive/root structure.
  expect(result[4]).toBe("file:///parser/worker.js");
  expect(result[5]).toBe("file:///worker.js");
});

// FINDING #3 (DIAG output, workflow_dispatch @ ff11cf0, real windows-x64
// runner — GROUND TRUTH at last):
//   DIAG: pool.ts import.meta.url = file:///B:/%7EBUN/root/project-brain-windows-x64
// The real Windows compiled import.meta.url percent-encodes the tilde:
// "%7EBUN", NOT "~BUN". Neither "$bunfs" nor "~BUN" substring-matches it,
// so detection fell into the dev branch (single sibling candidate) both
// times. Detection must also match the %7E-encoded marker (any case).
test("compiled Windows REAL shape (file:///B:/%7EBUN/...): detected as compiled, six candidates, plain strings first", () => {
  const result = workerEntryCandidates("file:///B:/%7EBUN/root/project-brain-windows-x64");
  expect(result).toEqual([
    ...PLAIN_STRING_CANDIDATES,
    "file:///B:/%7EBUN/root/parser/worker.js",
    "file:///B:/%7EBUN/root/worker.js",
  ]);
});

test("compiled Windows REAL shape, lowercase %7e variant: still detected as compiled", () => {
  const result = workerEntryCandidates("file:///B:/%7eBUN/root/project-brain-windows-x64");
  expect(result.length).toBe(6);
  expect(result[0]).toBe("./parser/worker.js");
});

test("first candidate is always the plain-string docs-canonical layout (./parser/worker.js) when compiled", () => {
  const posix = workerEntryCandidates("file:///$bunfs/root/cli");
  const winUrl = workerEntryCandidates("file:///B:/~BUN/root/cli.exe");
  expect(posix[0]).toBe("./parser/worker.js");
  expect(winUrl[0]).toBe("./parser/worker.js");
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
