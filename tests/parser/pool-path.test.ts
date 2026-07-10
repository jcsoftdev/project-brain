import { test, expect } from "bun:test";
import { resolveWorkerEntry } from "../../src/parser/pool.js";

// Regression coverage for the Windows release blocker (v0.7.0 → 3 failed
// releases on windows-x64 AND windows-arm64):
//
//   worker error: BuildMessage: ModuleNotFound resolving
//   "B:\~BUN\root\worker.js" (entry point)
//
// Root cause: the old detection (`import.meta.url.includes("/$bunfs/") ||
// import.meta.url.includes("/~BUN/")`) required POSIX slashes around the
// compiled-binary marker. On Windows, Bun mounts the embedded FS at
// `B:\~BUN\...` — backslashes, no leading/trailing slash around `~BUN` in
// the way the old check assumed — so IS_COMPILED was false, the dev
// (sibling `./worker.js`) path was chosen, and it resolved to the
// nonexistent `B:\~BUN\root\worker.js` instead of the actual bundled
// location `<root>\parser\worker.js`.

test("dev POSIX base resolves to a sibling ./worker.js (dev semantics preserved)", () => {
  const result = resolveWorkerEntry("file:///Users/x/project/src/parser/pool.ts");
  expect(result).toBe("file:///Users/x/project/src/parser/worker.js");
});

test("compiled POSIX base ($bunfs) resolves under parser/worker.js", () => {
  const result = resolveWorkerEntry("file:///$bunfs/root/cli");
  expect(result).toBe("file:///$bunfs/root/parser/worker.js");
});

test("compiled Windows URL-form base (file:///B:/~BUN/...) resolves under parser/worker.js, forward-slash form", () => {
  const result = resolveWorkerEntry("file:///B:/~BUN/root/cli.exe");
  expect(result).toBe("file:///B:/~BUN/root/parser/worker.js");
});

test("compiled Windows raw-path base (B:\\~BUN\\...) resolves under parser\\worker.js, backslash form preserved", () => {
  const result = resolveWorkerEntry("B:\\~BUN\\root\\cli.exe");
  expect(result).toBe("B:\\~BUN\\root\\parser\\worker.js");
});

test("compiled Windows URL-encoded base (%5C separators) is still detected as compiled and best-effort includes parser", () => {
  const result = resolveWorkerEntry("file:///B:%5C~BUN%5Croot%5Ccli.exe");
  expect(result).toContain("parser");
  expect(result).not.toBe(
    new URL("./worker.js", "file:///B:%5C~BUN%5Croot%5Ccli.exe").href,
  );
});
