/**
 * Import-specifier extraction.
 *
 * Not the WASM tree-sitter parser, on purpose: this runs inside a PreToolUse
 * hook on every edit, and `WasmParser` has to be initialised and have its
 * grammar loaded per process before it can read a single byte. The hook only
 * needs the module strings.
 *
 * A small lexer runs first so import syntax is matched in CODE only. A regex
 * over raw text reads `import x from "../infra"` inside a fixture string or a
 * docstring as a real dependency, and a block comment opener inside a string
 * (`"src/*"`) swallows the real imports after it. The lexer replaces every
 * string with an indexed placeholder and drops comments; the regexes then run on
 * that view and the specifier is looked up from the string token they matched.
 * Known blind spot: regex literals, which can hold an unbalanced quote. A miss
 * only means a boundary goes unchecked (fail open), never a wrong block.
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

/** Placeholder marker: a control character no source string around an import contains. */
const MARK = "\u0001";

interface Lexed {
  /** Source with comments blanked and each string replaced by `"\u0001<index>"`. */
  code: string;
  strings: string[];
}

/** Index just past the `${ ... }` expression that starts at `from` (after the `${`), skipping nested strings. */
function skipTemplateExpr(src: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < src.length && depth > 0) {
    const c = src[i]!;
    if (c === "'" || c === '"' || c === "`") i = scanString(src, i, "ts").end;
    else {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
  }
  return i;
}

/** Reads the string token opening at `start`; `end` is the index just past it. */
function scanString(src: string, start: number, lang: ImportLang): { end: number; value: string } {
  const quote = src[start]!;
  const n = src.length;

  if (lang === "py" && src.startsWith(quote.repeat(3), start)) {
    const close = quote.repeat(3);
    let i = start + 3;
    while (i < n && !src.startsWith(close, i)) i += src[i] === "\\" ? 2 : 1;
    return { end: Math.min(i + 3, n), value: src.slice(start + 3, Math.min(i, n)) };
  }

  if (quote === "`" && lang === "go") {
    const close = src.indexOf("`", start + 1);
    const end = close === -1 ? n : close;
    return { end: Math.min(end + 1, n), value: src.slice(start + 1, end) };
  }

  let i = start + 1;
  while (i < n) {
    const c = src[i]!;
    if (c === "\\") i += 2;
    else if (c === quote) return { end: i + 1, value: src.slice(start + 1, i) };
    // An unterminated '/" ends at the line, so one stray apostrophe cannot eat the file.
    else if (c === "\n" && quote !== "`") return { end: i, value: src.slice(start + 1, i) };
    else if (quote === "`" && c === "$" && src[i + 1] === "{") i = skipTemplateExpr(src, i + 2);
    else i++;
  }
  return { end: n, value: src.slice(start + 1, n) };
}

function lex(src: string, lang: ImportLang): Lexed {
  const strings: string[] = [];
  let code = "";
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const lineComment = lang === "py" ? c === "#" : c === "/" && src[i + 1] === "/";
    if (lineComment) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (lang !== "py" && c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      code += " ";
      continue;
    }
    const isQuote = c === "'" || c === '"' || (c === "`" && lang !== "py");
    if (isQuote) {
      const { end, value } = scanString(src, i, lang);
      code += `"${MARK}${strings.length}"`;
      strings.push(value);
      i = end;
      continue;
    }
    code += c;
    i++;
  }
  return { code, strings };
}

const SPEC = `"${MARK}(\\d+)"`;

function patterns(...sources: string[]): RegExp[] {
  return sources.map((s) => new RegExp(s.replaceAll("@STR@", SPEC), "g"));
}

const TS_PATTERNS = patterns(
  String.raw`\bimport\s*(?:type\s+)?(?:[^";]*?\bfrom\s*)?@STR@`,
  String.raw`\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*@STR@`,
  String.raw`\brequire\s*\(\s*@STR@\s*\)`,
  String.raw`\bimport\s*\(\s*@STR@\s*\)`
);

function extractTs({ code, strings }: Lexed): string[] {
  const out: string[] = [];
  for (const pattern of TS_PATTERNS) {
    for (const m of code.matchAll(pattern)) out.push(strings[Number(m[1])]!);
  }
  return out;
}

const GO_SINGLE = patterns(String.raw`^[ \t]*import[ \t]+(?:[\w.]+[ \t]+)?@STR@`)[0]!;
const GO_BLOCK = /^[ \t]*import\s*\(([\s\S]*?)\)/gm;
const GO_BLOCK_ENTRY = patterns(String.raw`^[ \t]*(?:[\w.]+[ \t]+)?@STR@`)[0]!;

function extractGo({ code, strings }: Lexed): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(new RegExp(GO_SINGLE.source, "gm"))) out.push(strings[Number(m[1])]!);
  for (const block of code.matchAll(GO_BLOCK)) {
    for (const m of block[1]!.matchAll(new RegExp(GO_BLOCK_ENTRY.source, "gm"))) out.push(strings[Number(m[1])]!);
  }
  return out;
}

function extractPython({ code }: Lexed): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm)) {
    for (const part of m[1]!.split(",")) out.push(part.trim().split(/\s+/)[0]!);
  }
  for (const m of code.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\(?[^\n]*)/gm)) {
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
  const lexed = lex(source, lang);
  const found = lang === "ts" ? extractTs(lexed) : lang === "go" ? extractGo(lexed) : extractPython(lexed);
  return [...new Set(found)];
}
