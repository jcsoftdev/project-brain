import { describe, it, expect } from "bun:test";
import type { BundleFile } from "../../src/okf/bundle.js";
import { parseDocument } from "../../src/okf/frontmatter.js";

/**
 * Turning a bundle concept into something the vector store can hold.
 *
 * Two rules carry the whole design:
 *
 * 1. Only concepts are indexed. index.md/log.md are navigation, references/ is
 *    external material — none of it is knowledge.
 * 2. The machine-managed block is stripped before indexing. It holds derived
 *    facts (anchors, line ranges, call edges) that find_symbol and friends
 *    already answer faster and fresher; indexing it would put code-shaped
 *    duplicates into the semantic index and let them compete with the prose
 *    that is the entire reason the bundle exists.
 */
function file(path: string, raw: string, kind: BundleFile["kind"] = "concept"): BundleFile {
  return { path, kind, raw, document: parseDocument(raw) };
}

const CONCEPT = [
  "---",
  "type: Decision",
  "title: Load grammars from bytes",
  "tags: [parser, bun]",
  "---",
  "",
  "# Why",
  "Language.load does not see /$bunfs.",
].join("\n");

describe("conceptToIndexable", () => {
  it("prefixes the body with the concept type and title so retrieval can hit on them", async () => {
    const { conceptToIndexable } = await import("../../src/okf/indexable.js");

    const result = conceptToIndexable(file("decisions/wasm.md", CONCEPT));

    expect(result?.content).toBe(
      ["[Decision] Load grammars from bytes", "tags: parser, bun", "", "# Why", "Language.load does not see /$bunfs."].join("\n")
    );
  });

  it("namespaces the source under okf/ and groups every concept in the okf module", async () => {
    const { conceptToIndexable } = await import("../../src/okf/indexable.js");

    const result = conceptToIndexable(file("decisions/wasm.md", CONCEPT));

    expect(result?.source).toBe("okf/decisions/wasm.md");
    expect(result?.module).toBe("okf");
  });

  it("strips the machine-managed block — derived facts do not belong in the semantic index", async () => {
    const { conceptToIndexable } = await import("../../src/okf/indexable.js");

    const raw = [
      "---",
      "type: Decision",
      "title: Load grammars from bytes",
      "---",
      "",
      "# Why",
      "Language.load does not see /$bunfs.",
      "",
      "<!-- project-brain:start -->",
      "| Symbol | Range |",
      "| `loadGrammar` | L14-24 |",
      "<!-- project-brain:end -->",
    ].join("\n");

    const result = conceptToIndexable(file("decisions/wasm.md", raw));

    expect(result?.content).not.toContain("loadGrammar");
    expect(result?.content).toContain("Language.load does not see /$bunfs.");
  });

  it("marks a non-stable status so stale guidance is not read as current", async () => {
    const { conceptToIndexable } = await import("../../src/okf/indexable.js");

    const raw = ["---", "type: Decision", "title: Old way", "status: deprecated", "---", "", "Body."].join("\n");

    const result = conceptToIndexable(file("decisions/old.md", raw));

    expect(result?.content.split("\n")[0]).toBe("[Decision · deprecated] Old way");
  });

  it("omits the status marker for the stable default", async () => {
    const { conceptToIndexable } = await import("../../src/okf/indexable.js");

    const raw = ["---", "type: Decision", "title: Current", "status: stable", "---", "", "Body."].join("\n");

    const result = conceptToIndexable(file("decisions/cur.md", raw));

    expect(result?.content.split("\n")[0]).toBe("[Decision] Current");
  });

  it("falls back to the file path when the concept has no title", async () => {
    const { conceptToIndexable } = await import("../../src/okf/indexable.js");

    const raw = ["---", "type: Gotcha", "---", "", "Body."].join("\n");

    const result = conceptToIndexable(file("gotchas/thing.md", raw));

    expect(result?.content.split("\n")[0]).toBe("[Gotcha] gotchas/thing.md");
  });

  it("returns null for a document with no type — §11's one required field", async () => {
    const { conceptToIndexable } = await import("../../src/okf/indexable.js");

    // §11 forbids rejecting a document over *optional* fields, unknown types or
    // broken links. `type` is none of those: without it the concept cannot be
    // labelled or reasoned about, and indexing it anyway would make a
    // non-conformant file work well enough that nobody ever fixes it.
    expect(conceptToIndexable(file("d/no-fm.md", "# Just prose"))).toBeNull();
    expect(conceptToIndexable(file("d/blank.md", ["---", "type: '  '", "---", "Body."].join("\n")))).toBeNull();
  });

  it("returns null for reserved and reference files", async () => {
    const { conceptToIndexable } = await import("../../src/okf/indexable.js");

    expect(conceptToIndexable(file("index.md", "# Bundle", "index"))).toBeNull();
    expect(conceptToIndexable(file("log.md", "# Log", "log"))).toBeNull();
    expect(conceptToIndexable(file("references/x.md", "# X", "reference"))).toBeNull();
  });

  it("returns null for a concept with no body left after stripping", async () => {
    const { conceptToIndexable } = await import("../../src/okf/indexable.js");

    const raw = ["---", "type: Decision", "title: Empty", "---", "", "<!-- project-brain:start -->", "derived", "<!-- project-brain:end -->"].join("\n");

    expect(conceptToIndexable(file("d/empty.md", raw))).toBeNull();
  });
});
