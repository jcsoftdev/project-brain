import { describe, it, expect } from "bun:test";
import {
  appendIndexEntry,
  computeBundleResource,
  pluralizeType,
  renderConcept,
  slugifyTitle,
} from "../../src/okf/write.js";

describe("slugifyTitle", () => {
  it("lowercases, hyphenates, and trims", () => {
    expect(slugifyTitle("Language.load ignores Bun's /$bunfs")).toBe("language-load-ignores-bun-s-bunfs");
  });

  it("caps length at 80 and never leaves a trailing hyphen", () => {
    const long = "a".repeat(200);
    expect(slugifyTitle(long).length).toBeLessThanOrEqual(80);
  });
});

describe("pluralizeType", () => {
  it("pluralizes the common OKF type vocabulary", () => {
    expect(pluralizeType("Decision")).toBe("decisions");
    expect(pluralizeType("Gotcha")).toBe("gotchas");
    expect(pluralizeType("Constraint")).toBe("constraints");
  });

  it("adds -es after s/x/z/ch/sh", () => {
    expect(pluralizeType("Bias")).toBe("biases");
  });

  it("turns a trailing consonant+y into -ies", () => {
    expect(pluralizeType("Strategy")).toBe("strategies");
  });
});

describe("computeBundleResource", () => {
  it("expresses a repo-relative path relative to the bundle root, POSIX-separated", () => {
    const resource = computeBundleResource("src/a.ts", null, { bundleRoot: "/repo/okf", repoRoot: "/repo" });
    expect(resource).toBe("../src/a.ts");
  });

  it("appends the #symbol fragment when given one", () => {
    const resource = computeBundleResource("src/a.ts", "alpha", { bundleRoot: "/repo/okf", repoRoot: "/repo" });
    expect(resource).toBe("../src/a.ts#alpha");
  });

  it("works for a bundle nested deeper than one level", () => {
    const resource = computeBundleResource("src/a.ts", null, { bundleRoot: "/repo/docs/okf", repoRoot: "/repo" });
    expect(resource).toBe("../../src/a.ts");
  });
});

describe("renderConcept", () => {
  it("renders parseable frontmatter with the required type and the given resource/sources", () => {
    const md = renderConcept({
      type: "Gotcha",
      title: "Title",
      description: "One line",
      tags: ["a", "b"],
      resource: "../src/a.ts#alpha",
      sources: [{ resource: "../src/b.ts#beta", title: "why it matters" }],
      status: "stable",
      generatedBy: "human:jcsoftdev",
      generatedAt: "2026-09-25T00:00:00Z",
      body: { Symptom: "It broke.", Why: "Because.", Fix: "Do this." },
    });

    expect(md).toContain("type: Gotcha");
    expect(md).toContain("resource: ../src/a.ts#alpha");
    expect(md).toContain("../src/b.ts#beta");
    expect(md).toContain("# Symptom");
    expect(md).toContain("It broke.");
    expect(md).toContain("# Why");
    expect(md).toContain("# Fix");
  });
});

describe("appendIndexEntry", () => {
  const index = ["# Knowledge", "", "## Gotchas", "* [A](/gotchas/a.md) - about a", "", "## Decisions", "* [D](/decisions/d.md) - about d", ""].join("\n");

  it("appends the new bullet after the last existing bullet in its section", () => {
    const updated = appendIndexEntry(index, "Gotchas", "* [B](/gotchas/b.md) - about b");
    const lines = updated.split("\n");
    const aIdx = lines.indexOf("* [A](/gotchas/a.md) - about a");
    const bIdx = lines.indexOf("* [B](/gotchas/b.md) - about b");
    const decisionsIdx = lines.indexOf("## Decisions");
    expect(bIdx).toBe(aIdx + 1);
    expect(bIdx).toBeLessThan(decisionsIdx);
    // The other section is untouched.
    expect(updated).toContain("* [D](/decisions/d.md) - about d");
  });

  it("creates a new section at the end of the file when the type has none yet", () => {
    const updated = appendIndexEntry(index, "Constraints", "* [C](/constraints/c.md) - about c");
    expect(updated).toContain("## Constraints\n* [C](/constraints/c.md) - about c");
    // Existing sections are unmodified.
    expect(updated).toContain("## Gotchas\n* [A](/gotchas/a.md) - about a");
  });

  it("inserts right after the heading when a section exists but is empty", () => {
    const emptySection = "# K\n\n## Gotchas\n\n## Decisions\n* [D](/decisions/d.md) - d\n";
    const updated = appendIndexEntry(emptySection, "Gotchas", "* [A](/gotchas/a.md) - a");
    const lines = updated.split("\n");
    expect(lines[lines.indexOf("## Gotchas") + 1]).toBe("* [A](/gotchas/a.md) - a");
  });
});
