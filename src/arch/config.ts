/**
 * `.project-brain/architecture.json`: the layers a project declares and the
 * dependencies between them that must not exist.
 *
 * Parsing is tolerant by contract. The file is hand-edited and consulted on
 * every edit the agent makes, so a typo in it must degrade to "that rule is
 * skipped" with a warning — never to a thrown error, and never to a guard that
 * blocks on a rule it half-understood.
 */

export type ArchMode = "block" | "warn";

export interface ArchRule {
  from: string;
  to: string[];
}

export interface LayerMatcher {
  /** Repo-relative POSIX globs matched against a file or a resolved import. */
  globs: Bun.Glob[];
  /** Bare package names (`pkg:pg`), the one way a layer can own a third-party import. */
  packages: string[];
}

export interface ArchConfig {
  layers: Map<string, LayerMatcher>;
  forbid: ArchRule[];
  mode: ArchMode;
}

export interface ParsedArchConfig {
  /** Null means "no deterministic check": the file is unusable, or declares nothing enforceable. */
  config: ArchConfig | null;
  /**
   * Read on its own, so a config too broken to enforce still says how loudly the
   * Jev layer may speak. Only an explicit `"block"` blocks; everything else warns.
   */
  mode: ArchMode;
  warnings: string[];
}

export const ARCH_CONFIG_PATH = ".project-brain/architecture.json";

const PACKAGE_PREFIX = "pkg:";

/** The hexagonal preset `arch init` writes. Warn, not block: a fresh install must never stop an edit. */
export const HEXAGONAL_PRESET = {
  layers: {
    domain: "src/domain/**",
    application: "src/application/**",
    infrastructure: "src/infra/**",
  },
  forbid: [
    { from: "domain", to: ["application", "infrastructure"] },
    { from: "application", to: ["infrastructure"] },
  ],
  mode: "warn",
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStrings(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  return null;
}

function buildMatcher(patterns: string[]): LayerMatcher {
  const matcher: LayerMatcher = { globs: [], packages: [] };
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith(PACKAGE_PREFIX)) matcher.packages.push(trimmed.slice(PACKAGE_PREFIX.length));
    else matcher.globs.push(new Bun.Glob(trimmed));
  }
  return matcher;
}

export function parseArchConfig(raw: unknown): ParsedArchConfig {
  const warnings: string[] = [];
  if (!isPlainObject(raw)) {
    return { config: null, mode: "warn", warnings: ["architecture.json must be a JSON object"] };
  }

  const mode: ArchMode = raw.mode === "block" ? "block" : "warn";
  if (raw.mode !== undefined && raw.mode !== "block" && raw.mode !== "warn") {
    warnings.push('"mode" must be "block" or "warn"; using "warn"');
  }

  const layers = new Map<string, LayerMatcher>();
  if (!isPlainObject(raw.layers)) {
    warnings.push('"layers" must be an object of layer name -> glob(s)');
  } else {
    for (const [name, value] of Object.entries(raw.layers)) {
      const patterns = toStrings(value);
      if (!patterns || patterns.length === 0) {
        warnings.push(`layer "${name}" needs a glob or an array of globs; ignored`);
        continue;
      }
      layers.set(name, buildMatcher(patterns));
    }
  }

  const forbid: ArchRule[] = [];
  if (raw.forbid !== undefined && !Array.isArray(raw.forbid)) warnings.push('"forbid" must be an array');
  const rules = Array.isArray(raw.forbid) ? raw.forbid : [];
  rules.forEach((rule, i) => {
    const to = isPlainObject(rule) ? toStrings(rule.to) : null;
    if (!isPlainObject(rule) || typeof rule.from !== "string" || !to) {
      warnings.push(`forbid[${i}] needs "from" (string) and "to" (string or array); ignored`);
      return;
    }
    const unknown = [rule.from, ...to].filter((name) => !layers.has(name));
    if (unknown.length > 0) warnings.push(`forbid[${i}] names undeclared layer(s): ${[...new Set(unknown)].join(", ")}`);
    const known = to.filter((name) => layers.has(name));
    if (layers.has(rule.from) && known.length > 0) forbid.push({ from: rule.from, to: known });
  });

  if (forbid.length === 0) {
    warnings.push("no enforceable forbid rule; deterministic check is off");
    return { config: null, mode, warnings };
  }
  return { config: { layers, forbid, mode }, mode, warnings };
}

/** Names of every layer a repo-relative POSIX path belongs to. */
export function layersOfPath(config: ArchConfig, repoPath: string): string[] {
  const out: string[] = [];
  for (const [name, matcher] of config.layers) {
    if (matcher.globs.some((g) => g.match(repoPath))) out.push(name);
  }
  return out;
}

/** Names of every layer that explicitly claims a bare package specifier. */
export function layersOfPackage(config: ArchConfig, specifier: string): string[] {
  const out: string[] = [];
  for (const [name, matcher] of config.layers) {
    if (matcher.packages.some((p) => specifier === p || specifier.startsWith(`${p}/`))) out.push(name);
  }
  return out;
}
