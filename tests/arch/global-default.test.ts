import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archGuardDecision, type ArchGuardContext } from "../../src/hooks/arch-guard.js";
import { HEXAGONAL_PRESET, layersOfPath, parseArchConfig } from "../../src/arch/config.js";
import { initGlobalArchConfig } from "../../src/commands/arch.js";
import type { SetupContext } from "../../src/setup/units.js";

const ROOT = "/proj";
const GLOBAL = "/home/me/.project-brain/architecture.json";
const PRESET = JSON.stringify(HEXAGONAL_PRESET);
const BLOCKING = JSON.stringify({ ...HEXAGONAL_PRESET, mode: "block" });

function ctx(files: Record<string, string>): ArchGuardContext {
  return {
    findRoot: () => ROOT,
    readFile: (p) => files[p] ?? null,
    exists: (p) => p in files,
    globalConfigPath: GLOBAL,
  };
}

const write = (file: string, content: string) => ({
  tool_name: "Write",
  tool_input: { file_path: `${ROOT}/${file}`, content },
});

const VIOLATION = 'import { db } from "../infra/db";\n';
const tree = { [`${ROOT}/src/infra/db.ts`]: "export const db = 1;\n" };

describe("config resolution", () => {
  it("uses the global default when the project has none, and names it in the reason", async () => {
    const d = await archGuardDecision(write("src/domain/user.ts", VIOLATION), ctx({ ...tree, [GLOBAL]: PRESET }));
    expect(d.block).toBe(false); // the preset warns
    expect(d.reason).toContain(`(global default: ${GLOBAL})`);
    expect(d.reason).toContain('"domain" must not depend on "infrastructure"');
  });

  it("blocks through a global config that says block", async () => {
    const d = await archGuardDecision(write("src/domain/user.ts", VIOLATION), ctx({ ...tree, [GLOBAL]: BLOCKING }));
    expect(d.block).toBe(true);
  });

  it("lets a project file replace the global one whole, with no merging", async () => {
    const own = JSON.stringify({
      layers: { ui: "src/ui/**", data: "src/infra/**" },
      forbid: [{ from: "ui", to: ["data"] }],
    });
    const files = { ...tree, [`${ROOT}/.project-brain/architecture.json`]: own, [GLOBAL]: BLOCKING };

    // The global domain rule is gone: only the project's layers exist.
    expect((await archGuardDecision(write("src/domain/user.ts", VIOLATION), ctx(files))).reason).toBeUndefined();

    const d = await archGuardDecision(write("src/ui/page.ts", 'import { db } from "../infra/db";\n'), ctx(files));
    expect(d.reason).toContain(".project-brain/architecture.json");
    expect(d.reason).not.toContain("global default");
    expect(d.block).toBe(false); // the project's mode is its own, not the global "block"
  });

  it("does not fall through to the global default when the project file is unparseable", async () => {
    const files = { ...tree, [`${ROOT}/.project-brain/architecture.json`]: "{ nope", [GLOBAL]: BLOCKING };
    expect(await archGuardDecision(write("src/domain/user.ts", VIOLATION), ctx(files))).toEqual({ block: false });
  });

  it("checks nothing when neither file exists", async () => {
    expect(await archGuardDecision(write("src/domain/user.ts", VIOLATION), ctx(tree))).toEqual({ block: false });
  });

  it('"mode": "off" in the global default opts out, and a project file can re-enable', async () => {
    const off = JSON.stringify({ ...HEXAGONAL_PRESET, mode: "off" });
    expect(await archGuardDecision(write("src/domain/user.ts", VIOLATION), ctx({ ...tree, [GLOBAL]: off }))).toEqual({
      block: false,
    });
    const files = { ...tree, [GLOBAL]: off, [`${ROOT}/.project-brain/architecture.json`]: BLOCKING };
    expect((await archGuardDecision(write("src/domain/user.ts", VIOLATION), ctx(files))).block).toBe(true);
  });
});

describe("hexagonal preset", () => {
  const config = parseArchConfig(HEXAGONAL_PRESET).config!;
  const layer = (p: string) => layersOfPath(config, p)[0];

  it.each([
    ["src/domain/user.ts", "domain"],
    ["packages/api/src/core/user.ts", "domain"],
    ["src/entities/user.ts", "domain"],
    ["src/use-cases/create.ts", "application"],
    ["app/usecases/create.ts", "application"],
    ["src/infra/db.ts", "infrastructure"],
    ["src/adapters/http/client.ts", "infrastructure"],
    ["src/infrastructure/db.ts", "infrastructure"],
  ])("places %s in %s", (path, expected) => {
    expect(layer(path)).toBe(expected);
  });

  it("resolves a multi-layer path to the first declared layer", () => {
    expect(layersOfPath(config, "src/infra/domain/x.ts")).toEqual(["domain"]);
    expect(layersOfPath(config, "src/application/adapters/x.ts")).toEqual(["application"]);
  });

  it("is a no-op for a repo whose paths match no layer", async () => {
    const files = { [GLOBAL]: BLOCKING, [`${ROOT}/lib/util.ts`]: "export {};\n", [`${ROOT}/lib/db.ts`]: "export {};\n" };
    const d = await archGuardDecision(write("lib/util.ts", 'import "./db";\n'), ctx(files));
    expect(d).toEqual({ block: false });
  });

  it("flags application -> infrastructure across spelling variants", async () => {
    const files = { [GLOBAL]: PRESET, [`${ROOT}/src/adapters/db.ts`]: "export {};\n" };
    const d = await archGuardDecision(write("src/use-cases/create.ts", 'import "../adapters/db";\n'), ctx(files));
    expect(d.reason).toContain('"application" must not depend on "infrastructure"');
  });
});

describe("hooks:arch-guard unit and the global file", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function context(): Promise<SetupContext> {
    const dir = await mkdtemp(join(tmpdir(), "pb-arch-global-"));
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
    } as SetupContext;
  }

  async function unit() {
    const { guidanceUnits } = await import("../../src/setup/units.js");
    return guidanceUnits().find((u) => u.id === "hooks:arch-guard")!;
  }

  it("apply seeds the preset; remove keeps the file; inspect needs both hook and file", async () => {
    const c = await context();
    const u = await unit();
    const path = join(c.dataDir, "architecture.json");

    await u.apply(c);
    expect(JSON.parse(await readFile(path, "utf8")).mode).toBe("warn");
    expect(await u.inspect(c)).toBe("current");

    await rm(path);
    expect(await u.inspect(c)).toBe("stale");

    await u.apply(c);
    await u.remove(c);
    expect(await u.inspect(c)).toBe("absent");
    expect(await Bun.file(path).exists()).toBe(true);
  });

  it("apply never overwrites a global file the user edited", async () => {
    const c = await context();
    await mkdir(c.dataDir, { recursive: true });
    const path = join(c.dataDir, "architecture.json");
    await writeFile(path, '{"mine":true}');

    await (await unit()).apply(c);
    expect(await readFile(path, "utf8")).toBe('{"mine":true}');
    expect(await initGlobalArchConfig(c.dataDir)).toBe("exists");
  });
});
