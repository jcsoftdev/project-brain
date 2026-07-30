import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { runOkfAudit } from "../../src/commands/okf.js";
import type { CodeChange, CodeClock } from "../../src/git/last-changed.js";

const silentClock: CodeClock = { lastChanged: () => ({ at: null, uncommitted: false }) };

function clockOf(answers: Record<string, CodeChange>): CodeClock {
  return { lastChanged: (path) => answers[path] ?? { at: null, uncommitted: false } };
}

/** alpha (a.ts) calls beta (b.ts); gamma (c.ts) is unexplained. */
function chainGraph(): GraphStore {
  const store = new GraphStore(openGraphDb(":memory:"));
  store.replaceFile("src/a.ts", "typescript", "h", 0, [
    {
      name: "alpha",
      kind: "function",
      signature: "",
      start_line: 1,
      end_line: 5,
      edges: [{ dst_name: "beta", edge_type: "call" }],
    },
  ]);
  store.replaceFile("src/b.ts", "typescript", "h", 0, [
    { name: "beta", kind: "function", signature: "", start_line: 1, end_line: 5, edges: [] },
  ]);
  store.replaceFile("src/c.ts", "typescript", "h", 0, [
    { name: "gamma", kind: "function", signature: "", start_line: 1, end_line: 5, edges: [] },
  ]);
  store.resolveEdgesForFiles(["src/a.ts", "src/b.ts", "src/c.ts"]);
  return store;
}

describe("runOkfAudit", () => {
  let root: string;
  let bundleDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-okf-audit-"));
    bundleDir = join(root, "okf");
    await mkdir(bundleDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(relPath: string, content: string): Promise<void> {
    const full = join(bundleDir, relPath);
    await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await writeFile(full, content);
  }

  const doc = (frontmatter: string[], body = "Because."): string =>
    ["---", ...frontmatter, "---", "", "# Why", body].join("\n");

  const deps = (overrides: Partial<Parameters<typeof runOkfAudit>[1]> = {}) => ({
    graph: chainGraph(),
    clock: silentClock,
    exists: () => true,
    repoRoot: root,
    ...overrides,
  });

  it("passes a bundle whose anchors all resolve and whose knowledge is current", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));

    const result = await runOkfAudit(bundleDir, deps());

    expect(result.ok).toBe(true);
    expect(result.output).toContain("1 anchor");
  });

  it("reports a broken anchor and fails the run", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/moved.ts"]));

    const result = await runOkfAudit(bundleDir, deps({ exists: (p: string) => p !== "src/moved.ts" }));

    expect(result.ok).toBe(false);
    expect(result.output).toContain("d/a.md");
    expect(result.output).toContain("../src/moved.ts");
    expect(result.output).toContain("file not found");
  });

  it("reports a stale concept with both dates so the author can judge it", async () => {
    await write(
      "d/a.md",
      doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }'])
    );

    const result = await runOkfAudit(
      bundleDir,
      deps({ clock: clockOf({ "src/a.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }) })
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("2026-06-01T00:00:00Z");
    expect(result.output).toContain("2026-01-01T00:00:00Z");
  });

  it("lists the highest-ranked code nothing explains without failing the run", async () => {
    // A documentation backlog is a suggestion, not a defect. Failing on it would
    // make the audit unusable in CI from the very first commit.
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));

    const result = await runOkfAudit(bundleDir, deps());

    expect(result.ok).toBe(true);
    expect(result.output).toContain("gamma");
  });

  it("suggests a link between concepts whose code calls across them", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));
    await write("d/b.md", doc(["type: Decision", "resource: ../src/b.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));

    const result = await runOkfAudit(bundleDir, deps());

    expect(result.ok).toBe(true);
    expect(result.output).toContain("d/a.md");
    expect(result.output).toContain("d/b.md");
    expect(result.output).toContain("alpha");
  });

  it("names the concepts to re-read when asked about a changed symbol", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));

    const result = await runOkfAudit(bundleDir, deps({ symbol: "beta" }));

    expect(result.output).toContain("beta");
    expect(result.output).toContain("d/a.md");
  });

  it("says so plainly when a changed symbol has no knowledge attached to it", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));

    const result = await runOkfAudit(bundleDir, deps({ symbol: "gamma" }));

    expect(result.ok).toBe(true);
    expect(result.output).toContain("no concept");
  });

  it("flags a concept that anchors code but was never attested", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts"]));

    const result = await runOkfAudit(bundleDir, deps());

    expect(result.output).toContain("never attested");
    expect(result.output).toContain("d/a.md");
  });

  it("reports a missing bundle directory as a message rather than a crash", async () => {
    const result = await runOkfAudit(join(root, "absent"), deps());

    expect(result.ok).toBe(false);
    expect(result.output).toContain("does not exist");
  });
});
