import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

/**
 * Reading an OKF bundle off disk (SPEC §2: the distribution unit is a directory
 * of markdown files). The reader classifies each file rather than assuming
 * everything is a concept: `index.md` and `log.md` are reserved navigation/history
 * (§8, §9), and anything under `references/` mirrors external material (§6.2) —
 * none of those are knowledge concepts, and validating them as such would report
 * false conformance errors.
 *
 * It never throws on bad content: issues are collected so one malformed file
 * cannot abort the walk.
 */
describe("readBundle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-okf-bundle-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(relPath: string, content: string): Promise<void> {
    const full = join(root, relPath);
    await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await writeFile(full, content);
  }

  const concept = (type: string, title: string) =>
    ["---", `type: ${type}`, `title: ${title}`, "---", "", "# Why", "Because."].join("\n");

  it("reads concept documents with bundle-relative paths", async () => {
    const { readBundle } = await import("../../src/okf/bundle.js");
    await write("decisions/wasm-bytes.md", concept("Decision", "Load grammars from bytes"));

    const bundle = await readBundle(root);

    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]?.path).toBe("decisions/wasm-bytes.md");
    expect(bundle.files[0]?.kind).toBe("concept");
    expect(bundle.files[0]?.document.frontmatter.type).toBe("Decision");
  });

  it("returns files sorted by path so output is deterministic", async () => {
    const { readBundle } = await import("../../src/okf/bundle.js");
    await write("z-last.md", concept("Gotcha", "Z"));
    await write("a-first.md", concept("Gotcha", "A"));
    await write("m/middle.md", concept("Gotcha", "M"));

    const bundle = await readBundle(root);

    expect(bundle.files.map((f) => f.path)).toEqual(["a-first.md", "m/middle.md", "z-last.md"]);
  });

  it("classifies the reserved index.md and log.md files", async () => {
    const { readBundle } = await import("../../src/okf/bundle.js");
    await write("index.md", "# Bundle");
    await write("log.md", "# Log\n## 2026-07-29\n* **Creation**: Init.");
    await write("d/thing.md", concept("Playbook", "Thing"));

    const bundle = await readBundle(root);

    const byPath = Object.fromEntries(bundle.files.map((f) => [f.path, f.kind]));
    expect(byPath).toEqual({ "index.md": "index", "log.md": "log", "d/thing.md": "concept" });
  });

  it("classifies anything under references/ as reference material, not a concept", async () => {
    const { readBundle } = await import("../../src/okf/bundle.js");
    await write("references/upstream-notes.md", "# Notes\nNo frontmatter here, and that is fine.");

    const bundle = await readBundle(root);

    expect(bundle.files[0]?.kind).toBe("reference");
    expect(bundle.issues).toEqual([]);
  });

  it("ignores files that are not markdown", async () => {
    const { readBundle } = await import("../../src/okf/bundle.js");
    await write("d/thing.md", concept("Playbook", "Thing"));
    await write("d/diagram.png", "not markdown");
    await write("references/script.py", "print('hi')");

    const bundle = await readBundle(root);

    expect(bundle.files.map((f) => f.path)).toEqual(["d/thing.md"]);
  });

  it("reads okf_version from the bundle-root index.md", async () => {
    const { readBundle } = await import("../../src/okf/bundle.js");
    await write("index.md", ["---", 'okf_version: "0.2"', "---", "# Bundle"].join("\n"));

    const bundle = await readBundle(root);

    expect(bundle.okfVersion).toBe("0.2");
  });

  it("reports a null okf_version when the bundle does not declare one", async () => {
    const { readBundle } = await import("../../src/okf/bundle.js");
    await write("d/thing.md", concept("Playbook", "Thing"));

    const bundle = await readBundle(root);

    expect(bundle.okfVersion).toBeNull();
  });

  it("collects conformance issues instead of throwing", async () => {
    const { readBundle } = await import("../../src/okf/bundle.js");
    await write("good.md", concept("Decision", "Good"));
    await write("bad.md", "# No frontmatter at all");

    const bundle = await readBundle(root);

    expect(bundle.files).toHaveLength(2);
    expect(bundle.issues.map((i) => [i.path, i.rule])).toEqual([["bad.md", "frontmatter-required"]]);
  });

  it("skips dot-directories so .git and friends never enter the bundle", async () => {
    const { readBundle } = await import("../../src/okf/bundle.js");
    await write("d/thing.md", concept("Playbook", "Thing"));
    await write(".git/HEAD.md", concept("Decision", "Not mine"));

    const bundle = await readBundle(root);

    expect(bundle.files.map((f) => f.path)).toEqual(["d/thing.md"]);
  });

  it("throws a typed error when the bundle root does not exist", async () => {
    const { readBundle, OkfBundleError } = await import("../../src/okf/bundle.js");

    const promise = readBundle(join(root, "nope"));

    await expect(promise).rejects.toBeInstanceOf(OkfBundleError);
  });
});
