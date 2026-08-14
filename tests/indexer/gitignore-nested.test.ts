import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadPatterns, shouldIgnore } from "../../src/indexer/gitignore.js";

/**
 * A nested .gitignore's rules were silently lost, which is how 73.7% of one
 * real index turned out to be PHP Composer `vendor/` — ignored by git, indexed
 * by us.
 */
describe("nested .gitignore semantics", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pb-gitignore-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(rel: string, content: string) {
    const path = join(root, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf-8");
  }

  it("applies a slashless subdir rule at any depth below that subdir", async () => {
    // git: a pattern with no internal slash matches at every level beneath the
    // .gitignore that declares it. Prefixing it to `sub/vendor/` anchored it to
    // one level and let `sub/api/vendor/**` through.
    await write("sub/.gitignore", "vendor/\n");
    const patterns = await loadPatterns(root);

    expect(shouldIgnore("sub/vendor/x.php", patterns)).toBe(true);
    expect(shouldIgnore("sub/api/vendor/x.php", patterns)).toBe(true);
    expect(shouldIgnore("sub/api/deep/vendor/x.php", patterns)).toBe(true);
  });

  it("keeps a leading-slash rule anchored to its own directory", async () => {
    // `/vendor` is anchored. Joining it produced `sub//vendor` — a double
    // slash that matched nothing at all.
    await write("sub/.gitignore", "/vendor\n");
    const patterns = await loadPatterns(root);

    expect(shouldIgnore("sub/vendor/x.php", patterns)).toBe(true);
    // Anchored means anchored: a deeper vendor/ is NOT covered by this rule.
    expect(shouldIgnore("other/vendor/x.php", patterns)).toBe(false);
  });

  it("does not leak a subdir rule to a sibling tree", async () => {
    await write("sub/.gitignore", "vendor/\n");
    const patterns = await loadPatterns(root);

    expect(shouldIgnore("elsewhere/vendor/x.php", patterns)).toBe(false);
  });

  it("still honours a root-level rule everywhere", async () => {
    await write(".gitignore", "vendor/\n");
    const patterns = await loadPatterns(root);

    expect(shouldIgnore("vendor/x.php", patterns)).toBe(true);
    expect(shouldIgnore("a/b/vendor/x.php", patterns)).toBe(true);
  });
});
