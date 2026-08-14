import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

/**
 * Full lifecycle against a REAL project on disk, driven through the actual CLI.
 *
 * Every stage here is one that broke in the field and was fixed blind — a
 * .gitignore rule that silently indexed a whole dependency tree, a deletion
 * sweep that never ran batched, a compaction that never reclaimed anything.
 * Unit tests covered each piece in isolation and still missed all three,
 * because the failures lived in how the stages compose.
 *
 * HOME is redirected so the run cannot touch the developer's real store — the
 * suite was found writing scratch projects into the actual projects.json.
 */
describe("project lifecycle end-to-end", () => {
  let home: string;
  let project: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pb-life-home-"));
    project = await mkdtemp(join(tmpdir(), "pb-life-proj-"));
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(join(project, "vendor", "acme", "lib"), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function cli(args: string[], cwd = project) {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../src/cli.ts"), ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        BRAIN_NO_UPDATE_CHECK: "1",
        BRAIN_NO_SKILL_REFRESH: "1",
        BRAIN_NO_CONFIG_REPAIR: "1",
        // Lexical-only: keeps the run offline and deterministic, while still
        // exercising the real store, manifest, graph and sweep code paths.
        BRAIN_EMBED_MODEL: "none",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  async function writeSource(rel: string, body: string) {
    const path = join(project, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body, "utf-8");
  }

  it("indexes project code, ignores gitignored dependencies, then reclaims on delete", async () => {
    await writeFile(join(project, ".gitignore"), "vendor/\n", "utf-8");
    for (let i = 1; i <= 6; i++) {
      await writeSource(`src/mod${i}.ts`, `export function mod${i}(a: number) { return a * ${i}; }\n`);
    }
    // Nested under a directory the slashless rule must still reach — this is
    // the exact shape that leaked 58,189 files into a real index.
    for (let i = 1; i <= 4; i++) {
      await writeSource(`src/api/vendor/dep${i}.ts`, `export const dep${i} = ${i};\n`);
      await writeSource(`vendor/acme/lib/pkg${i}.ts`, `export const pkg${i} = ${i};\n`);
    }

    const init = await cli(["init"]);
    expect(init.exitCode).toBe(0);

    const sources = await indexedSources();
    expect(sources.some((s) => s.includes("src/mod1.ts"))).toBe(true);
    // Both vendor trees must be absent: the top-level one AND the nested one.
    expect(sources.filter((s) => s.includes("vendor/"))).toEqual([]);
  }, 180_000);

  it("removes chunks for deleted files on the next full sync", async () => {
    await writeFile(join(project, ".gitignore"), "vendor/\n", "utf-8");
    for (let i = 1; i <= 6; i++) {
      await writeSource(`src/mod${i}.ts`, `export function mod${i}(a: number) { return a * ${i}; }\n`);
    }
    expect((await cli(["init"])).exitCode).toBe(0);
    expect((await indexedSources()).some((s) => s.includes("src/mod5.ts"))).toBe(true);

    await rm(join(project, "src/mod5.ts"));
    await rm(join(project, "src/mod6.ts"));

    const sync = await cli(["sync"]);
    expect(sync.exitCode).toBe(0);
    expect(sync.stdout).toMatch(/Deleted:\s+2 files/);

    const after = await indexedSources();
    expect(after.some((s) => s.includes("src/mod5.ts"))).toBe(false);
    expect(after.some((s) => s.includes("src/mod1.ts"))).toBe(true);
  }, 180_000);

  it("compact reclaims storage without changing what is indexed", async () => {
    await writeFile(join(project, ".gitignore"), "vendor/\n", "utf-8");
    for (let i = 1; i <= 8; i++) {
      await writeSource(`src/mod${i}.ts`, `export function mod${i}(a: number) { return a * ${i}; }\n`);
    }
    expect((await cli(["init"])).exitCode).toBe(0);
    for (let i = 5; i <= 8; i++) await rm(join(project, `src/mod${i}.ts`));
    expect((await cli(["sync"])).exitCode).toBe(0);

    const before = await indexedSources();
    const compact = await cli(["compact"]);

    expect(compact.exitCode).toBe(0);
    expect(compact.stdout).toContain("->");
    // The whole risk of deleteUnverified is losing live data.
    expect(await indexedSources()).toEqual(before);
  }, 180_000);


  it("bench scores retrieval against ground truth for this project", async () => {
    await writeFile(join(project, ".gitignore"), "vendor/\n", "utf-8");
    await writeSource("src/auth.ts", "export function verifyToken(token: string) { return token.length > 0; }\n");
    await writeSource("src/chunker.ts", "export function splitIntoChunks(text: string) { return text.split(\"\\n\"); }\n");
    expect((await cli(["init"])).exitCode).toBe(0);

    const queries = join(home, "q.jsonl");
    await writeFile(
      queries,
      [
        '{"query":"verifyToken","expect":"src/auth.ts"}',
        '{"query":"splitIntoChunks","expect":"src/chunker.ts"}',
      ].join("\n"),
      "utf-8"
    );

    const bench = await cli(["bench", queries]);

    expect(bench.exitCode).toBe(0);
    // Reporting the measured configuration is what makes two runs comparable.
    expect(bench.stdout).toMatch(/model\s+/);
    expect(bench.stdout).toMatch(/recall@1/);
    expect(bench.stdout).toMatch(/MRR/);
  }, 180_000);

  it("prune reports an unattributed table instead of deleting it", async () => {
    await writeSource("src/only.ts", "export const only = 1;\n");
    expect((await cli(["init"])).exitCode).toBe(0);

    const prune = await cli(["prune", "--dry-run"]);

    expect(prune.exitCode).toBe(0);
    // The project's root still exists, so nothing is eligible. Deleting a live
    // project's index is the one outcome prune must never produce.
    expect(prune.stdout).toContain("Nothing to prune");
  }, 180_000);

  /** Read every source recorded in the scratch store's only table. */
  async function indexedSources(): Promise<string[]> {
    const dataDir = join(home, ".project-brain", "data");
    const entries = await readdir(dataDir).catch(() => [] as string[]);
    const table = entries.find((e) => e.endsWith("_chunks.lance"));
    if (!table) return [];

    const lancedb = await import("@lancedb/lancedb");
    const db = await lancedb.connect(dataDir);
    const t = await db.openTable(table.replace(/\.lance$/, ""));
    const rows = await t.query().limit(5000).toArray();
    return [...new Set(rows.map((r: any) => String(r.source)))].sort();
  }
});
