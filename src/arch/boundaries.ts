import { posix } from "node:path";
import { layersOfPackage, layersOfPath, type ArchConfig, type ArchRule } from "./config.js";
import { extractImports, langForPath, type ImportLang } from "./imports.js";

/** Filesystem seam: repo-relative POSIX paths in, so tests never touch a disk. */
export interface ResolveEnv {
  exists(repoPath: string): boolean;
  /** Content of a repo-relative file, or null. Used only for `go.mod`. */
  readFile(repoPath: string): string | null;
}

export interface BoundaryViolation {
  rule: ArchRule;
  fromLayer: string;
  toLayer: string;
  specifier: string;
  /** The repo path the specifier resolved to, or null when the layer came from a `pkg:` match. */
  resolved: string | null;
}

export interface BoundaryInput {
  config: ArchConfig;
  /** Edited file, repo-relative POSIX. */
  file: string;
  /** Current content of the file; empty for a file being created. */
  before: string;
  after: string;
  env: ResolveEnv;
}

const TS_EXT_ALTERNATES: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const TS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"];

/**
 * Candidate repo paths for a relative TS/JS specifier, most likely first.
 *
 * `./x.js` resolving to `./x.ts` is the ESM-in-TypeScript convention this very
 * repo uses, so the written extension is tried as an alias for its source
 * extension before anything else.
 */
function tsCandidates(base: string): string[] {
  const dot = base.lastIndexOf(".");
  const ext = dot > base.lastIndexOf("/") ? base.slice(dot) : "";
  const stem = ext ? base.slice(0, dot) : base;
  const out: string[] = [];
  for (const alt of TS_EXT_ALTERNATES[ext] ?? []) out.push(stem + alt);
  out.push(base);
  for (const e of TS_EXTS) out.push(base + e);
  for (const e of TS_EXTS) out.push(`${base}/index${e}`);
  return out;
}

function pythonCandidates(dotted: string, fromFile: string): string[] {
  const leading = dotted.match(/^\.+/)?.[0].length ?? 0;
  const parts = dotted.slice(leading).split(".").filter(Boolean);
  let dir = "";
  if (leading > 0) {
    dir = posix.dirname(fromFile);
    for (let i = 1; i < leading; i++) dir = posix.dirname(dir);
  }
  const base = posix.join(dir, ...parts);
  if (base === "." || base === "") return [];
  return [`${base}.py`, `${base}/__init__.py`, base];
}

function goModule(env: ResolveEnv): string | null {
  return env.readFile("go.mod")?.match(/^\s*module\s+(\S+)/m)?.[1] ?? null;
}

/**
 * Repo paths a specifier could mean, or [] when it is a bare package.
 *
 * Returns the first candidate that exists on disk, else ALL candidates: an
 * import of a file that does not exist yet (the edit may be creating it) must
 * still land in the right layer, and which extension it will get is unknown.
 */
export function resolveImport(lang: ImportLang, specifier: string, fromFile: string, env: ResolveEnv): string[] {
  let candidates: string[] = [];
  if (lang === "ts") {
    if (!specifier.startsWith(".")) return [];
    candidates = tsCandidates(posix.normalize(posix.join(posix.dirname(fromFile), specifier)));
  } else if (lang === "py") {
    candidates = pythonCandidates(specifier, fromFile);
  } else {
    const module = goModule(env);
    if (module && (specifier === module || specifier.startsWith(`${module}/`))) {
      // A Go import names a package directory; the trailing slash is what lets `dir/**` match it.
      const dir = specifier.slice(module.length + 1);
      candidates = dir ? [`${dir}/`] : [];
    }
  }
  candidates = candidates.filter((c) => !c.startsWith("../") && c !== "..");
  const existing = candidates.find((c) => env.exists(c));
  return existing ? [existing] : candidates;
}

/** Spelling-independent identity of an import's target: extension and `/index` dropped, bare packages kept as written. */
function targetKey(lang: ImportLang, specifier: string, fromFile: string, env: ResolveEnv): string {
  const [first] = resolveImport(lang, specifier, fromFile, env);
  if (first === undefined) return `pkg:${specifier}`;
  return first.replace(/\.(?:[mc]?[jt]sx?|py)$/, "").replace(/\/(?:index|__init__)$/, "");
}

/**
 * Violations of the forbid rules among the imports an edit NEWLY introduces.
 *
 * Only the diff between the file's current imports and its post-edit imports
 * is judged. A violation that is already in the file must never block an edit
 * that does not touch it, or one legacy import would freeze the whole file.
 */
export function checkBoundaries(input: BoundaryInput): BoundaryViolation[] {
  const { config, file, before, after, env } = input;
  const lang = langForPath(file);
  if (!lang) return [];

  const fromLayers = layersOfPath(config, file);
  if (fromLayers.length === 0) return [];

  // Compared by what the specifier points at, not how it is spelled: `../infra/db`
  // becoming `../infra/db.js` is the same dependency and must not read as new.
  const existing = new Set(extractImports(lang, before).map((s) => targetKey(lang, s, file, env)));
  const introduced = extractImports(lang, after).filter((s) => !existing.has(targetKey(lang, s, file, env)));

  const violations: BoundaryViolation[] = [];
  const seen = new Set<string>();
  for (const specifier of introduced) {
    const candidates = resolveImport(lang, specifier, file, env);
    const targets: { layer: string; resolved: string | null }[] = [
      ...candidates.flatMap((c) => layersOfPath(config, c).map((layer) => ({ layer, resolved: c }))),
      ...layersOfPackage(config, specifier).map((layer) => ({ layer, resolved: null })),
    ];

    for (const rule of config.forbid) {
      if (!fromLayers.includes(rule.from)) continue;
      for (const target of targets) {
        if (!rule.to.includes(target.layer)) continue;
        const key = `${specifier}\0${rule.from}\0${target.layer}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({
          rule,
          fromLayer: rule.from,
          toLayer: target.layer,
          specifier,
          resolved: target.resolved,
        });
      }
    }
  }
  return violations;
}
