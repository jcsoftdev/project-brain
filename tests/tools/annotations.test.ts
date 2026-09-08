import { describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_CATALOG, toolAnnotations } from "../../src/constants.js";

const READ_ONLY = [
  "search_context", "expand_context", "find_symbol", "find_callers",
  "find_callees", "impact", "list_modules", "get_module", "check_health",
  "repo_map",
];

describe("tool annotations in TOOL_CATALOG", () => {
  it("every catalog entry has annotations with openWorldHint false", () => {
    for (const t of TOOL_CATALOG) {
      expect(t.annotations, `${t.name} missing annotations`).toBeDefined();
      expect(t.annotations!.openWorldHint).toBe(false);
    }
  });

  it("read-only tools are marked readOnlyHint", () => {
    for (const name of READ_ONLY) {
      expect(toolAnnotations(name)?.readOnlyHint, name).toBe(true);
    }
  });

  it("delete_knowledge is destructive and idempotent, add_knowledge idempotent only", () => {
    expect(toolAnnotations("delete_knowledge")).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(toolAnnotations("add_knowledge")).toMatchObject({ idempotentHint: true });
    expect(toolAnnotations("add_knowledge")?.destructiveHint).toBeUndefined();
  });

  it("registered MCP tools carry the catalog annotations", async () => {
    const { createServer } = await import("../../src/server.js");
    const noop = { dim: 4, embed: async () => null, isAvailable: async () => false } as any;
    // A DISPOSABLE projectRoot, never a shared one. createServer mkdirs
    // `<projectRoot>/.project-brain/` and opens graph.db with create:true, so
    // `projectRoot: "/tmp"` planted an empty graph at the root of the shared
    // temp directory. On Linux CI, where tmpdir() IS /tmp, every later test
    // whose fixture lived under it then walked up and found that graph —
    // structural-cli's "no .project-brain/ found" case got "Structural index is
    // empty" instead, and failed in a file it had no connection to. macOS never
    // reproduced it: tmpdir() there is per-user under /var/folders.
    const root = await mkdtemp(join(tmpdir(), "pb-annot-root-"));
    const { server } = await createServer({
      dbPath: join(root, "db"),
      embeddings: noop,
      projectRoot: root,
    });
    // Registered tools live on the McpServer's internal map.
    const registered = (server as any)._registeredTools;
    expect(registered["delete_knowledge"].annotations?.destructiveHint).toBe(true);
    expect(registered["search_context"].annotations?.readOnlyHint).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});
