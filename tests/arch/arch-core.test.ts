import { describe, it, expect } from "bun:test";
import { parseArchConfig, HEXAGONAL_PRESET, type ArchConfig } from "../../src/arch/config.js";
import { extractImports } from "../../src/arch/imports.js";
import { checkBoundaries, resolveImport, type ResolveEnv } from "../../src/arch/boundaries.js";

function config(raw: unknown = HEXAGONAL_PRESET): ArchConfig {
  const parsed = parseArchConfig(raw);
  if (!parsed.config) throw new Error(parsed.warnings.join("; "));
  return parsed.config;
}

function env(files: Record<string, string> = {}): ResolveEnv {
  return {
    exists: (p) => p in files,
    readFile: (p) => files[p] ?? null,
  };
}

describe("parseArchConfig", () => {
  it("accepts the hexagonal preset without warnings", () => {
    const parsed = parseArchConfig(HEXAGONAL_PRESET);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config?.mode).toBe("warn");
    expect([...parsed.config!.layers.keys()]).toEqual(["domain", "application", "infrastructure"]);
  });

  it("accepts an array of globs and a pkg: layer", () => {
    const cfg = config({
      layers: { domain: ["src/domain/**", "lib/core/**"], db: "pkg:pg", app: "src/app/**" },
      forbid: [{ from: "domain", to: "db" }],
    });
    expect(cfg.layers.get("domain")!.globs).toHaveLength(2);
    expect(cfg.layers.get("db")!.packages).toEqual(["pg"]);
    expect(cfg.mode).toBe("warn"); // a missing mode never blocks
  });

  // Each case is a bad config that must neither throw nor yield a check.
  const unusable: [string, unknown][] = [
    ["a string", "nope"],
    ["an array", []],
    ["null", null],
    ["no layers", { forbid: [{ from: "a", to: ["b"] }] }],
    ["no forbid", { layers: { a: "x/**" } }],
    ["forbid naming undeclared layers", { layers: { a: "x/**" }, forbid: [{ from: "a", to: ["ghost"] }] }],
    ["layers of the wrong type", { layers: { a: 3 }, forbid: [{ from: "a", to: ["a"] }] }],
  ];
  for (const [name, raw] of unusable) {
    it(`degrades to no check for ${name}`, () => {
      const parsed = parseArchConfig(raw);
      expect(parsed.config).toBeNull();
      expect(parsed.warnings.length).toBeGreaterThan(0);
    });
  }

  it("drops one malformed rule but keeps the valid ones", () => {
    const parsed = parseArchConfig({
      layers: { a: "a/**", b: "b/**" },
      forbid: [{ from: "a" }, { from: "a", to: ["b", "ghost"] }],
      mode: "loud",
    });
    expect(parsed.config?.forbid).toEqual([{ from: "a", to: ["b"] }]);
    expect(parsed.config?.mode).toBe("warn");
    expect(parsed.warnings.length).toBe(3);
  });

  it("reads mode on its own: only an explicit block blocks, even when nothing is enforceable", () => {
    expect(parseArchConfig({ mode: "block" })).toMatchObject({ config: null, mode: "block" });
    expect(parseArchConfig({ layers: 3, mode: "block" }).mode).toBe("block");
    expect(parseArchConfig({ mode: "warn" }).mode).toBe("warn");
    expect(parseArchConfig({}).mode).toBe("warn");
    expect(parseArchConfig({ mode: "BLOCK" }).mode).toBe("warn");
    expect(parseArchConfig("nope").mode).toBe("warn");
  });
});

describe("extractImports", () => {
  const cases: [string, "ts" | "go" | "py", string, string[]][] = [
    ["static, named, default and side-effect imports", "ts",
      `import a from "./a";\nimport { b, c } from '../b.js';\nimport * as d from "./d";\nimport "./side";\nimport type { T } from "./t";`,
      ["./a", "../b.js", "./d", "./side", "./t"]],
    ["multi-line named import", "ts", `import {\n  one,\n  two,\n} from "./multi";`, ["./multi"]],
    ["export-from", "ts", `export * from "./x";\nexport { y } from "./y";\nexport * as z from "./z";`, ["./x", "./y", "./z"]],
    ["require and dynamic import", "ts", `const a = require("./r");\nconst b = await import("./dyn");\nawait import(name);`, ["./r", "./dyn"]],
    ["ignores commented-out imports", "ts", `// import x from "./gone";\n/* import y from "./gone2"; */\nimport z from "./kept";`, ["./kept"]],
    ["keeps a URL inside a string", "ts", `const u = "http://x.test"; import q from "./q";`, ["./q"]],
    ["bare packages are still reported", "ts", `import pg from "pg";`, ["pg"]],
    ["go single and block imports", "go",
      `package x\nimport "fmt"\nimport alias "a/b"\nimport (\n  "os"\n  _ "side/effect"\n  m "mod/internal/domain"\n)\n`,
      ["fmt", "a/b", "os", "side/effect", "mod/internal/domain"]],
    // Import syntax inside a string or docstring is data, not a dependency.
    ["a template literal holding an import", "ts",
      "export const fixture = `\nimport { db } from \"../infra/db\";\n`;", []],
    ["a template literal with a nested ${} string", "ts",
      "const a = `x ${f(`y \"}\"`)} import q from \"./no\"`;\nimport r from \"./yes\";", ["./yes"]],
    ["an import inside a double-quoted string", "ts", `const s = "import { db } from '../infra/db'";`, []],
    ["an import inside a single-quoted string", "ts", `const s = 'import x from "../infra/db"';`, []],
    ["a block comment opener inside a string", "ts", `const g = "src/*";\nimport a from "./kept";\nconst h = "*/";`, ["./kept"]],
    ["a stray apostrophe does not eat the next line", "ts", `// it's\nconst s = "don't";\nimport a from "./kept";`, ["./kept"]],
    ["a go raw string holding an import", "go", "package x\nvar s = `import \"mod/internal/infra\"`\nimport \"real/pkg\"\n", ["real/pkg"]],
    ["a python docstring holding an import", "py",
      'def f():\n    """\n    from ..infra.db import x\n    import os\n    """\nimport sys\n', ["sys"]],
    ["a python triple-single-quote string and a # comment", "py", "s = \'\'\'\nimport nope\n\'\'\'\n# import also_nope\nimport yes\n", ["yes"]],
    ["python import and from-import", "py",
      `import os, sys as s\nimport a.b.c\nfrom d.e import f\nfrom .rel import g\nfrom .. import h, i as j\n# import nope\n`,
      ["os", "sys", "a.b.c", "d.e", ".rel", "..h", "..i"]],
  ];
  for (const [name, lang, src, expected] of cases) {
    it(name, () => expect(extractImports(lang, src)).toEqual(expected));
  }
});

describe("resolveImport", () => {
  it("maps a .js specifier onto its .ts source", () => {
    const e = env({ "src/domain/user.ts": "" });
    expect(resolveImport("ts", "./user.js", "src/domain/a.ts", e)).toEqual(["src/domain/user.ts"]);
  });

  it("falls back to /index when the file is a directory", () => {
    const e = env({ "src/infra/db/index.ts": "" });
    expect(resolveImport("ts", "../infra/db", "src/domain/a.ts", e)).toEqual(["src/infra/db/index.ts"]);
  });

  it("returns every candidate for a file that does not exist yet", () => {
    const out = resolveImport("ts", "../infra/new", "src/domain/a.ts", env());
    expect(out).toContain("src/infra/new.ts");
    expect(out).toContain("src/infra/new/index.ts");
  });

  it("treats bare specifiers and escapes from the repo as unresolved", () => {
    expect(resolveImport("ts", "pg", "src/a.ts", env())).toEqual([]);
    expect(resolveImport("ts", "../../../outside", "src/a.ts", env())).toEqual([]);
  });

  it("resolves a go import through the go.mod module path", () => {
    const e = env({ "go.mod": "module example.com/app\n\ngo 1.22\n" });
    expect(resolveImport("go", "example.com/app/internal/infra", "internal/domain/a.go", e)).toEqual(["internal/infra/"]);
    expect(resolveImport("go", "github.com/other/lib", "internal/domain/a.go", e)).toEqual([]);
  });

  it("resolves python absolute and relative modules", () => {
    const e = env({ "src/infra/db.py": "" });
    expect(resolveImport("py", "src.infra.db", "src/domain/a.py", e)).toEqual(["src/infra/db.py"]);
    expect(resolveImport("py", "..infra.db", "src/domain/a.py", e)).toEqual(["src/infra/db.py"]);
  });
});

describe("checkBoundaries", () => {
  const check = (file: string, before: string, after: string, files: Record<string, string> = {}, raw?: unknown) =>
    checkBoundaries({ config: config(raw), file, before, after, env: env(files) });

  const FILES = { "src/infra/db.ts": "", "src/application/use.ts": "", "src/domain/entity.ts": "" };

  it("flags a newly introduced forbidden import, with the layers involved", () => {
    const v = check("src/domain/user.ts", "", `import { db } from "../infra/db";`, FILES);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ fromLayer: "domain", toLayer: "infrastructure", specifier: "../infra/db", resolved: "src/infra/db.ts" });
  });

  // The positive case above is the twin that makes these three negatives mean something.
  it("allows an import in the permitted direction", () => {
    expect(check("src/infra/repo.ts", "", `import { u } from "../application/use";`, FILES)).toEqual([]);
    expect(check("src/application/use.ts", "", `import { e } from "../domain/entity";`, FILES)).toEqual([]);
  });

  it("allows a file in no layer to import anything", () => {
    expect(check("scripts/seed.ts", "", `import { db } from "../src/infra/db";`, FILES)).toEqual([]);
  });

  it("never judges an import that was already there", () => {
    const legacy = `import { db } from "../infra/db";\n`;
    const v = check("src/domain/user.ts", legacy, `${legacy}export const x = 1;\n`, FILES);
    expect(v).toEqual([]);
  });

  it("judges only the added import when a legacy one is also present", () => {
    const legacy = `import { db } from "../infra/db";\n`;
    const after = `${legacy}import { u } from "../application/use";\n`;
    const v = check("src/domain/user.ts", legacy, after, FILES);
    expect(v.map((x) => x.toLayer)).toEqual(["application"]);
  });

  it("flags an import of a file that does not exist yet", () => {
    const v = check("src/domain/user.ts", "", `import { n } from "../infra/brand-new";`);
    expect(v.map((x) => x.toLayer)).toEqual(["infrastructure"]);
  });

  it("ignores bare packages unless a layer names them", () => {
    expect(check("src/domain/user.ts", "", `import pg from "pg";`)).toEqual([]);
    const raw = { layers: { domain: "src/domain/**", db: "pkg:pg" }, forbid: [{ from: "domain", to: ["db"] }] };
    const v = check("src/domain/user.ts", "", `import pg from "pg";\nimport q from "pg/lib/query";`, {}, raw);
    expect(v.map((x) => [x.specifier, x.toLayer, x.resolved])).toEqual([["pg", "db", null], ["pg/lib/query", "db", null]]);
  });

  it("ignores files of unsupported languages", () => {
    expect(check("src/domain/readme.md", "", `import x from "../infra/db"`, FILES)).toEqual([]);
  });

  it("checks go and python files", () => {
    const goRaw = { layers: { domain: "internal/domain/**", infra: "internal/infra/**" }, forbid: [{ from: "domain", to: ["infra"] }] };
    const gomod = { "go.mod": "module ex.com/app\n" };
    const g = check("internal/domain/a.go", "", `import "ex.com/app/internal/infra"`, gomod, goRaw);
    expect(g.map((x) => x.resolved)).toEqual(["internal/infra/"]);

    const pyRaw = { layers: { domain: "app/domain/**", infra: "app/infra/**" }, forbid: [{ from: "domain", to: ["infra"] }] };
    const p = check("app/domain/a.py", "", `from app.infra.db import conn`, { "app/infra/db.py": "" }, pyRaw);
    expect(p.map((x) => x.resolved)).toEqual(["app/infra/db.py"]);
  });

  it("does not treat a respelled import as new", () => {
    const files = { "src/infra/db.ts": "" };
    const spellings = ["../infra/db", "../infra/db.js", "../infra/db.ts", "../infra/db/index"];
    for (const a of spellings) {
      for (const b of spellings) {
        if (a === b) continue;
        const v = check("src/domain/user.ts", `import { db } from "${a}";\n`, `import { db } from "${b}";\n`, files);
        expect(v).toEqual([]);
      }
    }
    // The twin: a genuinely different target is still caught.
    const other = check("src/domain/user.ts", `import { db } from "../infra/db.js";\n`, `import { x } from "../infra/other.js";\n`, files);
    expect(other).toHaveLength(1);
  });

  it("does not flag an import that only appears inside a string in the new content", () => {
    const after = "export const fixture = `\nimport { db } from \"../infra/db\";\n`;\n";
    expect(check("src/domain/user.ts", "", after, { "src/infra/db.ts": "" })).toEqual([]);
  });

  it("reports one violation per rule even when several candidates match", () => {
    const v = check("src/domain/user.ts", "", `import { n } from "../infra/brand-new";`);
    expect(v).toHaveLength(1);
  });
});
