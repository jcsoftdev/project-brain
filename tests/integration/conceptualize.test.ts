import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { VECTOR_DIM } from "../../src/constants.js";
import { handleSearch } from "../../src/tools/search.js";
import { runConceptualize } from "../../src/commands/conceptualize.js";
import type { EmbeddingClient, ToolDeps } from "../../src/types.js";
import type { LlmClient } from "../../src/llm/anthropic-client.js";

function git(root: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

const mockEmbeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
  embed: async (texts) =>
    texts.map((t) => {
      const vec = new Array(VECTOR_DIM).fill(0);
      for (let i = 0; i < t.length; i++) vec[i % VECTOR_DIM] += t.charCodeAt(i) / 1000;
      return vec;
    }),
  isAvailable: async () => true,
};

const mockLlm: LlmClient = {
  complete: async () =>
    "## Purpose\n\nHandles authentication.\n\n## Key Files\n\nauth/login.ts\n\n## Dependencies\n\nNone.\n\n## Data Flow\n\nRequest, validate, token.\n\n## Gotchas\n\nNone yet.",
};

describe("Integration: conceptualize", () => {
  let root: string;
  let dbDir: string;
  let store: LanceDbStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-concept-root-"));
    dbDir = await mkdtemp(join(tmpdir(), "brain-concept-db-"));
    store = new LanceDbStore(dbDir);
    await store.ensureTable("testproj", { model: "mock", dim: VECTOR_DIM });

    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    await mkdir(join(root, "auth"), { recursive: true });
    await writeFile(join(root, "auth", "login.ts"), "export function login() {}\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feat(auth): add login"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it("generates a concept doc for the changed module and makes it searchable", async () => {
    const result = await runConceptualize(
      { root, projectId: "testproj" },
      { store, embeddings: mockEmbeddings, llm: mockLlm }
    );

    expect(result.processed).toEqual(["auth"]);
    expect(result.skipped).toEqual([]);

    const deps: ToolDeps = { store, embeddings: mockEmbeddings };
    const searchResult = await handleSearch(
      { project: "testproj", query: "Handles authentication" },
      deps
    );
    expect(JSON.stringify(searchResult)).toContain("Handles authentication");
  });
});
