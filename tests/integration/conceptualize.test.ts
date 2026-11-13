import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { VECTOR_DIM } from "../../src/constants.js";
import { handleSearch } from "../../src/tools/search.js";
import { runConceptualize } from "../../src/commands/conceptualize.js";
import { acquirePidFileLock } from "../../src/commands/sync-lock.js";
import { readConceptDoc } from "../../src/concept/store.js";
import { existsSync } from "node:fs";
import type { EmbeddingClient, ToolDeps } from "../../src/types.js";
import { LlmUnavailableError, type LlmClient } from "../../src/llm/client.js";

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

  it("processes onlyModule even when the latest commit didn't touch it", async () => {
    // Add a second module (billing/) in its own commit, then a follow-up commit
    // that only touches auth/ — so the latest commit's changed-files set never
    // includes billing/, mimicking a module logged as "pending" from an earlier run.
    await mkdir(join(root, "billing"), { recursive: true });
    await writeFile(join(root, "billing", "invoice.ts"), "export function invoice() {}\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feat(billing): add invoice"]);

    await writeFile(join(root, "auth", "login.ts"), "export function login() { return true; }\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fix(auth): tweak login"]);

    const result = await runConceptualize(
      { root, projectId: "testproj", onlyModule: "billing" },
      { store, embeddings: mockEmbeddings, llm: mockLlm }
    );

    expect(result.processed).toContain("billing");
    expect(result.skipped).toEqual([]);
  });

  it("skips every module with one line, without retrying, when the backend is missing", async () => {
    await mkdir(join(root, "billing"), { recursive: true });
    await writeFile(join(root, "billing", "invoice.ts"), "export function invoice() {}\n");
    await writeFile(join(root, "auth", "login.ts"), "export function login() { return 1; }\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feat: touch two modules"]);

    let calls = 0;
    const missing: LlmClient = {
      complete: async () => {
        calls++;
        throw new LlmUnavailableError("`claude` is not on PATH");
      },
    };
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      const result = await runConceptualize({ root, projectId: "testproj" }, { store, embeddings: mockEmbeddings, llm: missing });
      expect(result.processed).toEqual([]);
      expect(result.skipped).toEqual(["auth", "billing"]);
    } finally {
      console.error = original;
    }
    expect(calls).toBe(1);
    expect(lines).toEqual(["[project-brain] conceptualize: `claude` is not on PATH; skipped 2 module(s): auth, billing"]);
  });

  it("never writes a malformed or truncated doc", async () => {
    let calls = 0;
    const malformed: LlmClient = {
      complete: async () => {
        calls++;
        return "## Purpose\n\nHandles auth.\n\n## Key Files\n\nlogin.ts\n\n## Depend";
      },
    };
    const original = console.error;
    console.error = () => {};
    try {
      const result = await runConceptualize({ root, projectId: "testproj" }, { store, embeddings: mockEmbeddings, llm: malformed });
      expect(result).toEqual({ processed: [], skipped: ["auth"] });
    } finally {
      console.error = original;
    }
    expect(calls).toBe(2);
    expect(await readConceptDoc("testproj", "auth", store)).toBe("");
  });

  it("skips with one line while another run holds the conceptualize lock", async () => {
    const lockPath = join(dbDir, "conceptualize.lock");
    const held = await acquirePidFileLock(lockPath);
    expect(held).not.toBeNull();
    let calls = 0;
    const counting: LlmClient = {
      complete: async (p) => {
        calls++;
        return mockLlm.complete(p);
      },
    };
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      const busy = await runConceptualize({ root, projectId: "testproj", lockPath }, { store, embeddings: mockEmbeddings, llm: counting });
      expect(busy).toEqual({ processed: [], skipped: ["auth"] });
      expect(calls).toBe(0);
      expect(lines).toEqual([`[project-brain] conceptualize: another run is in progress (pid ${process.pid}); skipped 1 module(s): auth`]);
    } finally {
      console.error = original;
      await held!.release();
    }

    const free = await runConceptualize({ root, projectId: "testproj", lockPath }, { store, embeddings: mockEmbeddings, llm: counting });
    expect(free.processed).toEqual(["auth"]);
    expect(existsSync(lockPath)).toBe(false);
  });
});
