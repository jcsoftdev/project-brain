/**
 * `okf init` scaffolds an empty bundle.
 *
 * Two decisions this locks in:
 *
 * 1. **No seeded concepts.** A bundle shipped with example concepts would make
 *    the first `audit` report coverage gaps for the whole repo — noise on day
 *    one, before anyone has written a single real thing.
 * 2. **It refreshes the CLAUDE.md rules.** `project-brain init` runs before any
 *    bundle exists, so the conditional knowledge-bundle section is absent at
 *    that point. If `okf init` did not re-render it, the instruction telling the
 *    host the bundle exists would never appear.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pb-okf-init-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bundle = () => join(root, "okf");

describe("runOkfInit", () => {
  it("creates index.md and log.md and reports them", async () => {
    const { runOkfInit } = await import("../../src/okf/init.js");
    const result = await runOkfInit({ root });

    expect(result.created.sort()).toEqual(["index.md", "log.md"]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(bundle(), "index.md"))).toBe(true);
    expect(existsSync(join(bundle(), "log.md"))).toBe(true);
  });

  /** §8: the root index MAY carry exactly one frontmatter key — the version. */
  it("declares okf_version 0.2 in the root index, and nothing else", async () => {
    const { runOkfInit } = await import("../../src/okf/init.js");
    await runOkfInit({ root });

    const index = await readFile(join(bundle(), "index.md"), "utf8");
    expect(index).toMatch(/^---\n/);
    expect(index).toContain('okf_version: "0.2"');
    const frontmatter = index.split("---")[1];
    expect(frontmatter.trim().split("\n")).toHaveLength(1);
  });

  it("seeds no concepts — the bundle starts empty", async () => {
    const { runOkfInit } = await import("../../src/okf/init.js");
    await runOkfInit({ root });

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(bundle(), { withFileTypes: true });
    const conceptFiles = entries.filter(
      (e) => e.isFile() && e.name.endsWith(".md") && !["index.md", "log.md"].includes(e.name)
    );
    expect(conceptFiles).toEqual([]);
  });

  it("passes okf validate on a freshly created bundle", async () => {
    const { runOkfInit } = await import("../../src/okf/init.js");
    const { readBundle } = await import("../../src/okf/bundle.js");
    await runOkfInit({ root });

    // readBundle runs validateFile over every document it finds; a fresh bundle
    // must be conformant with no hand-editing, or `okf init` shipped a lie.
    const result = await readBundle(bundle());
    expect(result.issues).toEqual([]);
  });

  it("never overwrites an existing file — reports it as skipped", async () => {
    const { runOkfInit } = await import("../../src/okf/init.js");
    await mkdir(bundle(), { recursive: true });
    const mine = "---\nokf_version: \"0.2\"\n---\n\n# My own index\n";
    await writeFile(join(bundle(), "index.md"), mine);

    const result = await runOkfInit({ root });

    expect(result.skipped).toContain("index.md");
    expect(result.created).toContain("log.md");
    expect(await readFile(join(bundle(), "index.md"), "utf8")).toBe(mine);
  });

  it("is idempotent — a second run creates nothing and skips everything", async () => {
    const { runOkfInit } = await import("../../src/okf/init.js");
    await runOkfInit({ root });
    const second = await runOkfInit({ root });

    expect(second.created).toEqual([]);
    expect(second.skipped.sort()).toEqual(["index.md", "log.md"]);
  });

  it("refreshes the project rules so the host learns the bundle exists", async () => {
    const { runOkfInit } = await import("../../src/okf/init.js");
    let refreshed = 0;
    await runOkfInit({ root, refreshRules: async () => { refreshed++; } });
    expect(refreshed).toBe(1);
  });

  /** A rules refresh is a nicety; failing it must not leave a half-made bundle. */
  it("still reports the created bundle when the rules refresh throws", async () => {
    const { runOkfInit } = await import("../../src/okf/init.js");
    const result = await runOkfInit({
      root,
      refreshRules: async () => { throw new Error("no CLAUDE.md"); },
    });
    expect(result.created.sort()).toEqual(["index.md", "log.md"]);
    expect(existsSync(join(bundle(), "index.md"))).toBe(true);
  });

  it("honours an explicit bundle dir", async () => {
    const { runOkfInit } = await import("../../src/okf/init.js");
    const custom = join(root, "knowledge");
    await runOkfInit({ root, dir: custom });
    expect(existsSync(join(custom, "index.md"))).toBe(true);
    expect(existsSync(join(bundle(), "index.md"))).toBe(false);
  });
});
