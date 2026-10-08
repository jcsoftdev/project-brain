import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJevEnv, type JevEnvContext } from "../../src/hooks/jev-env.js";
import { removeJevEnvHooks, upsertJevEnvHooks, upsertRoutingHooks } from "../../src/hooks/claude-settings.js";
import type { SetupContext } from "../../src/setup/units.js";

/** In-memory env file: records every append. */
function memCtx(
  opts: { env?: Record<string, string>; token?: string | null; file?: string | null } = {}
) {
  const writes: Array<{ path: string; data: string }> = [];
  const ctx: JevEnvContext = {
    env: { CLAUDE_ENV_FILE: "/env-file", ...opts.env },
    readFile: async () => opts.file ?? null,
    appendFile: async (path, data) => {
      writes.push({ path, data });
    },
    resolveToken: async () => (opts.token === undefined ? "tok-123" : opts.token),
  };
  return { ctx, writes };
}

describe("exportJevEnv", () => {
  it("appends one export line to CLAUDE_ENV_FILE", async () => {
    const { ctx, writes } = memCtx();
    expect(await exportJevEnv(ctx)).toBe(true);
    expect(writes).toEqual([{ path: "/env-file", data: "export TYPESAFE_API_KEY='tok-123'\n" }]);
  });

  it("POSIX-escapes a single quote in the token", async () => {
    const { ctx, writes } = memCtx({ token: "a'b$c" });
    await exportJevEnv(ctx);
    expect(writes[0]!.data).toBe("export TYPESAFE_API_KEY='a'\\''b$c'\n");
  });

  it("the escaped line round-trips through a real shell", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-jev-env-"));
    try {
      const file = join(dir, "env.sh");
      const token = `we'ird "tok" $HOME \`x\``;
      const { ctx } = memCtx({ token, env: { CLAUDE_ENV_FILE: file } });
      ctx.appendFile = async (p, d) => writeFile(p, d, { flag: "a" });
      await exportJevEnv(ctx);
      const out = Bun.spawnSync(["sh", "-c", `. '${file}'; printf %s "$TYPESAFE_API_KEY"`]);
      expect(out.stdout.toString()).toBe(token);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips when the process env already has the key", async () => {
    const { ctx, writes } = memCtx({ env: { TYPESAFE_API_KEY: "already" } });
    expect(await exportJevEnv(ctx)).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("skips when no token resolves", async () => {
    const { ctx, writes } = memCtx({ token: null });
    expect(await exportJevEnv(ctx)).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("skips when CLAUDE_ENV_FILE is unset", async () => {
    const { ctx, writes } = memCtx();
    delete ctx.env.CLAUDE_ENV_FILE;
    expect(await exportJevEnv(ctx)).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("does not duplicate an export already in the file", async () => {
    const { ctx, writes } = memCtx({ file: "export OTHER=1\nexport TYPESAFE_API_KEY='x'\n" });
    expect(await exportJevEnv(ctx)).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("starts a new line when the file does not end with one", async () => {
    const { ctx, writes } = memCtx({ file: "export OTHER=1" });
    await exportJevEnv(ctx);
    expect(writes[0]!.data.startsWith("\nexport TYPESAFE_API_KEY=")).toBe(true);
  });

  it("execute() prints nothing and never exposes the token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-jev-env-"));
    const out: string[] = [];
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const prevFile = process.env.CLAUDE_ENV_FILE;
    const prevKey = process.env.TYPESAFE_API_KEY;
    try {
      process.env.CLAUDE_ENV_FILE = join(dir, "env.sh");
      delete process.env.TYPESAFE_API_KEY;
      process.stdout.write = ((c: unknown) => (out.push(String(c)), true)) as typeof process.stdout.write;
      process.stderr.write = ((c: unknown) => (out.push(String(c)), true)) as typeof process.stderr.write;
      const { execute } = await import("../../src/hooks/jev-env.js");
      await execute();
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
      if (prevFile === undefined) delete process.env.CLAUDE_ENV_FILE;
      else process.env.CLAUDE_ENV_FILE = prevFile;
      if (prevKey !== undefined) process.env.TYPESAFE_API_KEY = prevKey;
      await rm(dir, { recursive: true, force: true });
    }
    expect(out.join("")).toBe("");
  });
});

describe("upsertJevEnvHooks / removeJevEnvHooks", () => {
  const sessionStart = (s: any): any[] => s.hooks?.SessionStart ?? [];

  it("installs a short-timeout SessionStart group", () => {
    const [group] = sessionStart(upsertJevEnvHooks(null));
    expect(group.hooks[0]).toMatchObject({
      type: "command",
      command: "project-brain jev-env",
      timeout: 5,
    });
    expect(group.hooks[0].statusMessage).toStartWith("project-brain:");
  });

  it("is idempotent and does not mutate its input", () => {
    const once = upsertJevEnvHooks(null);
    expect(upsertJevEnvHooks(once)).toEqual(once);
    const existing = { hooks: { SessionStart: [] as any[] } };
    upsertJevEnvHooks(existing);
    expect(existing.hooks.SessionStart).toHaveLength(0);
  });

  it("preserves other hooks and settings on both upsert and remove", () => {
    const withRouting = upsertRoutingHooks({ permissions: { allow: ["Bash(ls:*)"] } }, { strict: false });
    const both: any = upsertJevEnvHooks(withRouting);
    expect(sessionStart(both)).toHaveLength(2);

    const removed: any = removeJevEnvHooks(both);
    expect(sessionStart(removed).map((g: any) => g.hooks[0].command)).toEqual([
      "project-brain routing-rules",
    ]);
    expect(removed.permissions).toEqual({ allow: ["Bash(ls:*)"] });
  });

  it("removal drops the SessionStart key when empty and tolerates absence", () => {
    expect((removeJevEnvHooks(upsertJevEnvHooks(null)) as any).hooks.SessionStart).toBeUndefined();
    expect(() => removeJevEnvHooks(null)).not.toThrow();
  });
});

describe("config:reranker unit with the export hook", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function context(): Promise<SetupContext> {
    const dir = await mkdtemp(join(tmpdir(), "pb-jev-unit-"));
    dirs.push(dir);
    return {
      dataDir: join(dir, "data"),
      installed: [],
      serverPath: "/usr/local/bin/project-brain",
      claudeSettingsPath: join(dir, "settings.json"),
      recordConfigPath: join(dir, "record-config.json"),
      selectionPath: join(dir, "setup-selection.json"),
      skillTargetDirs: [join(dir, "skills")],
      recordConnection: { mode: "fresh", cdpPort: 9222 },
      hookStrict: { routing: false, worktree: false },
      skipOllama: true,
    };
  }

  async function unit() {
    const { otherUnits } = await import("../../src/setup/units.js");
    return otherUnits().find((u) => u.id === "config:reranker")!;
  }

  it("apply installs token and hook; remove takes both", async () => {
    const u = await unit();
    const ctx = await context();
    ctx.rerankerToken = "sk-1";

    expect(await u.inspect(ctx)).toBe("absent");
    await u.apply(ctx);
    expect(await u.inspect(ctx)).toBe("current");
    expect(await readFile(ctx.claudeSettingsPath, "utf8")).toContain("project-brain jev-env");

    await u.remove(ctx);
    expect(await u.inspect(ctx)).toBe("absent");
    expect(await readFile(ctx.claudeSettingsPath, "utf8")).not.toContain("jev-env");
  });

  it("a token without the hook is stale, and apply heals it without prompting", async () => {
    const u = await unit();
    const ctx = await context();
    const { writeRerankerToken, resolveRerankerToken } = await import("../../src/rerank/token.js");
    await writeRerankerToken(ctx.dataDir, "existing-token");
    await writeFile(ctx.claudeSettingsPath, JSON.stringify({ theme: "dark" }));

    const prev = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    let prompted = false;
    ctx.promptRerankerToken = async () => {
      prompted = true;
      return null;
    };
    try {
      expect(await u.inspect(ctx)).toBe("stale");
      await u.apply(ctx);
      expect(prompted).toBe(false);
      expect(await u.inspect(ctx)).toBe("current");
      expect(await resolveRerankerToken({ dataDir: ctx.dataDir, env: {} })).toBe("existing-token");
      expect(JSON.parse(await readFile(ctx.claudeSettingsPath, "utf8")).theme).toBe("dark");
    } finally {
      if (prev !== undefined) process.env.TYPESAFE_API_KEY = prev;
    }
  });
});
