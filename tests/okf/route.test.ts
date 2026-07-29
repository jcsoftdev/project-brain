import { describe, it, expect } from "bun:test";

/**
 * The regular indexer and the OKF pipeline write to the same table, keyed by
 * the same repo-relative path. Without a routing decision they fight: sync
 * chunks the bundle file raw (frontmatter as text, managed block included) and
 * clobbers the curated version — on every commit, because the git hook runs
 * sync. This function is that decision, kept pure so it can be tested without
 * standing up a whole sync run.
 */
describe("routeOkfFile", () => {
  const CONCEPT = [
    "---",
    "type: Gotcha",
    "title: Language.load ignores /$bunfs",
    "---",
    "",
    "# Why",
    "Emscripten bypasses the virtual filesystem.",
  ].join("\n");

  it("returns null for a file outside the bundle so it takes the normal path", async () => {
    const { routeOkfFile } = await import("../../src/okf/route.js");

    expect(routeOkfFile("src/parser/wasm.ts", "const a = 1;", "okf")).toBeNull();
  });

  it("routes a concept inside the bundle through the OKF projection", async () => {
    const { routeOkfFile } = await import("../../src/okf/route.js");

    const result = routeOkfFile("okf/gotchas/bunfs.md", CONCEPT, "okf");

    if (!result || result.skip) throw new Error("expected the concept to be routed, not skipped");
    expect(result.module).toBe("okf");
    expect(result.content.split("\n")[0]).toBe("[Gotcha] Language.load ignores /$bunfs");
  });

  it("works for a bundle nested anywhere in the repo", async () => {
    const { routeOkfFile } = await import("../../src/okf/route.js");

    const result = routeOkfFile("docs/knowledge/gotchas/bunfs.md", CONCEPT, "docs/knowledge");

    if (!result || result.skip) throw new Error("expected the concept to be routed, not skipped");
    expect(result.module).toBe("okf");
  });

  it("does not match a sibling directory that merely shares the prefix", async () => {
    const { routeOkfFile } = await import("../../src/okf/route.js");

    expect(routeOkfFile("okf-drafts/notes.md", CONCEPT, "okf")).toBeNull();
  });

  it("skips reserved navigation files — they are structure, not knowledge", async () => {
    const { routeOkfFile } = await import("../../src/okf/route.js");

    expect(routeOkfFile("okf/index.md", "# Bundle", "okf")).toEqual({ skip: true });
    expect(routeOkfFile("okf/log.md", "# Log", "okf")).toEqual({ skip: true });
  });

  it("skips reference material under references/", async () => {
    const { routeOkfFile } = await import("../../src/okf/route.js");

    expect(routeOkfFile("okf/references/upstream.md", "# Notes", "okf")).toEqual({ skip: true });
  });

  it("skips a non-conformant document rather than letting it fall back to raw indexing", async () => {
    const { routeOkfFile } = await import("../../src/okf/route.js");

    // Falling back to the raw path would index the file under a module derived
    // from its directory, quietly re-creating the collision this routing exists
    // to remove.
    expect(routeOkfFile("okf/gotchas/no-type.md", "# Just prose", "okf")).toEqual({ skip: true });
  });

  it("skips non-markdown files that happen to live in the bundle", async () => {
    const { routeOkfFile } = await import("../../src/okf/route.js");

    expect(routeOkfFile("okf/references/helper.py", "print('hi')", "okf")).toEqual({ skip: true });
  });
});
