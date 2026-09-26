import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { handleOkfWrite } from "../../src/tools/okf-write.js";
import type { ToolDeps } from "../../src/types.js";

function graphWithAlpha(): GraphStore {
  const store = new GraphStore(openGraphDb(":memory:"));
  store.replaceFile("src/a.ts", "typescript", "h", 0, [
    { name: "alpha", kind: "function", signature: "", start_line: 1, end_line: 5, edges: [] },
  ]);
  store.resolveEdgesForFiles(["src/a.ts"]);
  return store;
}

describe("handleOkfWrite", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-okf-tool-write-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export function alpha() {}\n");
    await mkdir(join(root, "okf"), { recursive: true });
    await writeFile(
      join(root, "okf", "index.md"),
      ["---", 'okf_version: "0.2"', "---", "", "# Knowledge", "", "## Gotchas", "* [Existing](/gotchas/existing.md) - already there", ""].join("\n")
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function deps(graph = graphWithAlpha()): ToolDeps {
    return { graph, projectId: "p", projectRoot: root } as unknown as ToolDeps;
  }

  const baseArgs = {
    type: "Gotcha",
    title: "Alpha does something surprising",
    description: "one line",
    tags: ["a"],
    resource: "src/a.ts#alpha",
    body: { Symptom: "It broke.", Why: "Because.", Fix: "Do this." },
  };

  it("writes the concept file, never overwrites, and appends the index bullet", async () => {
    const result = await handleOkfWrite(baseArgs, deps());
    expect(result.isError).toBeUndefined();
    const payload = result.structuredContent as any;
    expect(payload.path).toBe("gotchas/alpha-does-something-surprising.md");

    const written = await readFile(join(root, "okf", "gotchas", "alpha-does-something-surprising.md"), "utf-8");
    expect(written).toContain("type: Gotcha");
    expect(written).toContain("resource: ../src/a.ts#alpha");
    expect(written).toContain("# Symptom");

    const index = await readFile(join(root, "okf", "index.md"), "utf-8");
    expect(index).toContain("[Alpha does something surprising](/gotchas/alpha-does-something-surprising.md)");
    expect(index).toContain("* [Existing](/gotchas/existing.md) - already there");
  });

  it("refuses and writes nothing when the primary anchor does not resolve", async () => {
    const result = await handleOkfWrite({ ...baseArgs, resource: "src/a.ts#nope" }, deps());
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).code).toBe("ANCHOR_UNRESOLVED");
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(root, "okf", "gotchas"))).toBe(false);
  });

  it("refuses and writes nothing when a source anchor does not resolve, naming it", async () => {
    const result = await handleOkfWrite(
      { ...baseArgs, sources: [{ resource: "src/missing.ts", title: "x" }] },
      deps()
    );
    expect(result.isError).toBe(true);
    const payload = result.structuredContent as any;
    expect(payload.code).toBe("ANCHOR_UNRESOLVED");
    expect(JSON.stringify(payload.unresolved)).toContain("src/missing.ts");
  });

  it("never overwrites an existing concept file", async () => {
    await handleOkfWrite(baseArgs, deps());
    const second = await handleOkfWrite(baseArgs, deps());
    expect(second.isError).toBe(true);
    expect((second.structuredContent as any).code).toBe("ALREADY_EXISTS");
  });

  it("creates a new section in index.md for a type with no existing entries", async () => {
    const result = await handleOkfWrite({ ...baseArgs, type: "Decision", title: "Pick alpha over beta" }, deps());
    expect(result.isError).toBeUndefined();
    const index = await readFile(join(root, "okf", "index.md"), "utf-8");
    expect(index).toContain("## Decisions");
    expect(index).toContain("[Pick alpha over beta](/decisions/pick-alpha-over-beta.md)");
  });

  it("errors with PROJECT_MISMATCH rather than writing into another project's repo", async () => {
    const result = await handleOkfWrite({ ...baseArgs, project: "other" } as any, deps());
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).code).toBe("PROJECT_MISMATCH");
  });
});
