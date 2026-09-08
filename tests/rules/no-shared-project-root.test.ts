import { describe, it, expect } from "bun:test";
import { join, relative } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const TESTS_ROOT = join(import.meta.dir, "..");

/** Every .test.ts under tests/, as repo-relative paths. */
async function testFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(TESTS_ROOT, { withFileTypes: true, recursive: true })) {
    // Skip this file: it necessarily contains the pattern it searches for.
    if (e.name === "no-shared-project-root.test.ts") continue;
    if (e.isFile() && e.name.endsWith(".test.ts")) out.push(join(e.parentPath, e.name));
  }
  return out.sort();
}

/**
 * A projectRoot that is not disposable, i.e. a literal shared directory or the
 * bare temp root rather than an mkdtemp'd one.
 */
const SHARED_ROOT = /projectRoot:\s*(?:"\/tmp"|"\/tmp\/"|'\/tmp'|tmpdir\(\)|`\$\{tmpdir\(\)\}`)/;

describe("no test may claim a shared directory as a project root", () => {
  it("finds no `projectRoot` pointing at the bare temp root", async () => {
    // createServer mkdirs `<projectRoot>/.project-brain/` and opens graph.db
    // with create:true. One test passing `projectRoot: "/tmp"` planted an empty
    // graph at the root of the shared temp directory, and on Linux CI — where
    // tmpdir() IS /tmp — every later test whose fixture lived under it walked
    // up and found that graph. It failed structural-cli's "no .project-brain/
    // found" case, in a file with no connection to the one at fault, and only
    // on CI: macOS tmpdir() is per-user under /var/folders, so it never
    // reproduced locally. Two release runs died on it.
    const offenders: string[] = [];
    for (const file of await testFiles()) {
      const src = await readFile(file, "utf8");
      src.split("\n").forEach((line, i) => {
        // Comments are allowed to name the anti-pattern — that is how the
        // reason survives next to the code that had to stop doing it.
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
        if (SHARED_ROOT.test(line)) {
          offenders.push(`${relative(TESTS_ROOT, file)}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      `use mkdtemp(join(tmpdir(), "...")) for a projectRoot, not a shared one: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("leaves no marker at the temp root after this suite has run", async () => {
    // The symptom the lint above prevents, asserted directly.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tmpdir(), ".project-brain"))).toBe(false);
  });
});
