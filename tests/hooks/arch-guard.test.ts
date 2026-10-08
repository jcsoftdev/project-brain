import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archGuardDecision, postEditContent, type ArchGuardContext } from "../../src/hooks/arch-guard.js";
import { initArchConfig } from "../../src/commands/arch.js";

const ROOT = "/proj";
const CONFIG = JSON.stringify({
  layers: { domain: "src/domain/**", infrastructure: "src/infra/**" },
  forbid: [{ from: "domain", to: ["infrastructure"] }],
  mode: "block",
});

/** In-memory project: absolute path -> content. */
function memCtx(files: Record<string, string>): ArchGuardContext {
  return {
    findRoot: () => ROOT,
    readFile: (p) => files[p] ?? null,
    exists: (p) => p in files,
  };
}

const base = (extra: Record<string, string> = {}) => ({
  [`${ROOT}/.project-brain/architecture.json`]: CONFIG,
  [`${ROOT}/src/infra/db.ts`]: "export const db = 1;\n",
  ...extra,
});

const write = (file: string, content: string) => ({
  tool_name: "Write",
  tool_input: { file_path: `${ROOT}/${file}`, content },
});
const edit = (file: string, old_string: string, new_string: string, replace_all?: boolean) => ({
  tool_name: "Edit",
  tool_input: { file_path: `${ROOT}/${file}`, old_string, new_string, replace_all },
});

describe("postEditContent", () => {
  it("Edit replaces the first occurrence, or all with replace_all", () => {
    const input = { old_string: "a", new_string: "b" };
    expect(postEditContent("Edit", input, "aXa")).toBe("bXa");
    expect(postEditContent("Edit", { ...input, replace_all: true }, "aXa")).toBe("bXb");
  });

  it("Edit does not interpret `$` in the replacement", () => {
    expect(postEditContent("Edit", { old_string: "a", new_string: "$&$1" }, "a")).toBe("$&$1");
  });

  it("MultiEdit applies edits in order, each seeing the previous result", () => {
    const input = { edits: [{ old_string: "a", new_string: "b" }, { old_string: "b", new_string: "c" }] };
    expect(postEditContent("MultiEdit", input, "a")).toBe("c");
  });

  it("is null when the old string is missing, in any position of a MultiEdit", () => {
    expect(postEditContent("Edit", { old_string: "zzz", new_string: "x" }, "abc")).toBeNull();
    const input = { edits: [{ old_string: "a", new_string: "b" }, { old_string: "zzz", new_string: "x" }] };
    expect(postEditContent("MultiEdit", input, "a")).toBeNull();
  });

  it("Write takes the content as given, without needing the current file", () => {
    expect(postEditContent("Write", { content: "new" }, null)).toBe("new");
  });
});

describe("archGuardDecision", () => {
  const violating = `import { db } from "../infra/db";\n`;

  it("blocks a Write whose new content breaks a boundary, and says how to fix it", async () => {
    const d = await archGuardDecision(write("src/domain/user.ts", violating), memCtx(base()));
    expect(d.block).toBe(true);
    expect(d.reason).toContain('"domain" must not depend on "infrastructure"');
    expect(d.reason).toContain("../infra/db");
    expect(d.reason).toContain("src/infra/db.ts");
    expect(d.reason).toContain("Fix:");
  });

  it("blocks an Edit that adds the import to an existing file", async () => {
    const files = base({ [`${ROOT}/src/domain/user.ts`]: "export const u = 1;\n" });
    const d = await archGuardDecision(edit("src/domain/user.ts", "export const u = 1;", `${violating}export const u = 1;`), memCtx(files));
    expect(d.block).toBe(true);
  });

  it("allows an unrelated edit to a file that already violates", async () => {
    const files = base({ [`${ROOT}/src/domain/user.ts`]: `${violating}export const u = 1;\n` });
    const d = await archGuardDecision(edit("src/domain/user.ts", "u = 1", "u = 2"), memCtx(files));
    expect(d).toEqual({ block: false });
  });

  it("allows a clean edit in a layered file", async () => {
    const d = await archGuardDecision(write("src/domain/user.ts", "export const u = 1;\n"), memCtx(base()));
    expect(d.block).toBe(false);
  });

  it("warn mode reports the reason without blocking", async () => {
    const files = base({ [`${ROOT}/.project-brain/architecture.json`]: CONFIG.replace('"block"', '"warn"') });
    const d = await archGuardDecision(write("src/domain/user.ts", violating), memCtx(files));
    expect(d.block).toBe(false);
    expect(d.reason).toContain("Architecture boundary violation");
  });

  it("fails open on every unreadable input", async () => {
    const files = base();
    const allow = { block: false };
    expect(await archGuardDecision(null, memCtx(files))).toEqual(allow);
    expect(await archGuardDecision({ tool_name: "Bash", tool_input: { command: "ls" } }, memCtx(files))).toEqual(allow);
    expect(await archGuardDecision({ tool_name: "Edit", tool_input: {} }, memCtx(files))).toEqual(allow);
    // Edit of a file that cannot be read.
    expect(await archGuardDecision(edit("src/domain/ghost.ts", "a", violating), memCtx(files))).toEqual(allow);
    // Old string not in the file.
    const present = base({ [`${ROOT}/src/domain/user.ts`]: "x\n" });
    expect(await archGuardDecision(edit("src/domain/user.ts", "nope", violating), memCtx(present))).toEqual(allow);
    // No project, no config, bad config.
    expect(await archGuardDecision(write("src/domain/a.ts", violating), { ...memCtx(files), findRoot: () => null })).toEqual(allow);
    expect(await archGuardDecision(write("src/domain/a.ts", violating), memCtx({}))).toEqual(allow);
    expect(await archGuardDecision(write("src/domain/a.ts", violating), memCtx({ [`${ROOT}/.project-brain/architecture.json`]: "{nope" }))).toEqual(allow);
    // A throwing context.
    const boom = { ...memCtx(files), readFile: () => { throw new Error("disk"); } };
    expect(await archGuardDecision(write("src/domain/a.ts", violating), boom)).toEqual(allow);
  });

  it("ignores files outside the project root", async () => {
    const d = await archGuardDecision({ tool_name: "Write", tool_input: { file_path: "/elsewhere/src/domain/a.ts", content: violating } }, memCtx(base()));
    expect(d.block).toBe(false);
  });
});

describe("initArchConfig", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const tmp = async () => {
    const dir = await mkdtemp(join(tmpdir(), "arch-init-"));
    dirs.push(dir);
    return dir;
  };

  it("writes the preset in warn mode", async () => {
    const dir = await tmp();
    expect(await initArchConfig(dir)).toBe("written");
    const written = JSON.parse(await readFile(join(dir, ".project-brain", "architecture.json"), "utf8"));
    expect(written.mode).toBe("warn");
    expect(Object.keys(written.layers)).toEqual(["domain", "application", "infrastructure"]);
  });

  it("refuses to overwrite without --force, and overwrites with it", async () => {
    const dir = await tmp();
    await mkdir(join(dir, ".project-brain"));
    const path = join(dir, ".project-brain", "architecture.json");
    await writeFile(path, '{"mine":true}');

    expect(await initArchConfig(dir)).toBe("exists");
    expect(await readFile(path, "utf8")).toBe('{"mine":true}');
    expect(await initArchConfig(dir, { force: true })).toBe("written");
    expect(JSON.parse(await readFile(path, "utf8")).layers).toBeDefined();
  });
});

describe("arch-guard CLI entry", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function run(payload: object, mode: "block" | "warn") {
    const dir = await mkdtemp(join(tmpdir(), "arch-hook-"));
    dirs.push(dir);
    await mkdir(join(dir, ".project-brain"));
    await writeFile(join(dir, ".project-brain", "architecture.json"), CONFIG.replace('"block"', `"${mode}"`));
    const file = join(dir, "src", "domain", "user.ts");
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "..", "src", "cli.ts"), "arch-guard"], {
      stdin: new Blob([JSON.stringify({ ...payload, tool_input: { ...(payload as any).tool_input, file_path: file } })]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BRAIN_NO_UPDATE_CHECK: "1", BRAIN_NO_SKILL_REFRESH: "1", TYPESAFE_API_KEY: "" },
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { stderr, code };
  }

  const violating = { tool_name: "Write", tool_input: { content: `import { db } from "../infra/db";\n` } };

  it("exits 2 with the reason on stderr when blocking", async () => {
    const { stderr, code } = await run(violating, "block");
    expect(code).toBe(2);
    expect(stderr).toContain("Architecture boundary violation");
  });

  it("exits 0 in warn mode and still writes the reason to stderr", async () => {
    const { stderr, code } = await run(violating, "warn");
    expect(code).toBe(0);
    expect(stderr).toContain("Architecture boundary violation");
  });
});
