/**
 * Import-specifier extraction, by regex.
 *
 * Not the WASM tree-sitter parser, on purpose: this runs inside a PreToolUse
 * hook on every edit, and `WasmParser` has to be initialised and have its
 * grammar loaded per process before it can read a single byte. The hook only
 * needs the module strings, which a comment-stripped regex finds reliably; a
 * miss means a boundary goes unchecked (fail open), never a wrong block.
 */

export type ImportLang = "ts" | "go" | "py";

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

export function langForPath(path: string): ImportLang | null {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  if (TS_EXTS.has(ext)) return "ts";
  if (ext === ".go") return "go";
  if (ext === ".py") return "py";
  return null;
}

function stripCComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // Not after `:` or a quote, so a URL inside a string survives.
    .replace(/(^|[^:\\'"`])\/\/.*$/gm, "$1");
}

const TS_PATTERNS: RegExp[] = [
  /\bimport\s*(?:type\s+)?(?:[^'";]*?\bfrom\s*)?(['"])([^'"\n]+)\1/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\1/g,
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

function extractTs(source: string): string[] {
  const clean = stripCComments(source);
  const out: string[] = [];
  for (const pattern of TS_PATTERNS) {
    for (const m of clean.matchAll(pattern)) out.push(m[2]!);
  }
  return out;
}

function extractGo(source: string): string[] {
  const clean = stripCComments(source);
  const out: string[] = [];
  for (const m of clean.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"\n]+)"/gm)) out.push(m[1]!);
  for (const block of clean.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
    for (const m of block[1]!.matchAll(/^\s*(?:[\w.]+\s+)?"([^"\n]+)"/gm)) out.push(m[1]!);
  }
  return out;
}

function extractPython(source: string): string[] {
  const clean = source.replace(/^\s*#.*$/gm, "");
  const out: string[] = [];
  for (const m of clean.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm)) {
    for (const part of m[1]!.split(",")) out.push(part.trim().split(/\s+/)[0]!);
  }
  for (const m of clean.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\(?[^\n]*)/gm)) {
    const module = m[1]!;
    if (/^\.+$/.test(module)) {
      // `from . import x` names submodules, so each name is its own specifier.
      for (const name of m[2]!.replace(/[()]/g, "").split(",")) {
        const bare = name.trim().split(/\s+/)[0];
        if (bare && /^\w+$/.test(bare)) out.push(`${module}${bare}`);
      }
    } else {
      out.push(module);
    }
  }
  return out;
}

/** Every module specifier a source file imports, deduplicated, in first-seen order. */
export function extractImports(lang: ImportLang, source: string): string[] {
  const found = lang === "ts" ? extractTs(source) : lang === "go" ? extractGo(source) : extractPython(source);
  return [...new Set(found)];
}
