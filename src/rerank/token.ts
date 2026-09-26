import { join } from "node:path";
import { DATA_DIR } from "../constants.js";

export interface TokenResolveOptions {
  /** Overrides the data dir the token file is read from/written to. Defaults to DATA_DIR (~/.project-brain). */
  dataDir?: string;
  /** Overrides the env lookup for testing. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** Path to the reranker token file, given a data dir (defaults to DATA_DIR). */
export function rerankerTokenPath(dataDir: string = DATA_DIR): string {
  return join(dataDir, "reranker.json");
}

/** Where a resolved TypeSafe token came from — surfaced by health/help so an agent can find it without grepping source. */
export type RerankerTokenSource = "env" | "file";

export interface ResolvedRerankerToken {
  token: string;
  source: RerankerTokenSource;
  /** Set only when source is "file" — the path the token was read from. Never the token itself. */
  path?: string;
}

/**
 * Resolve the TypeSafe API token AND where it came from: `TYPESAFE_API_KEY`
 * env var first, then `<dataDir>/reranker.json` (`{ "token": "..." }`).
 * Never logs or throws — any failure (file absent, unparseable, empty token)
 * resolves to null, which callers treat as "reranking is off".
 */
export async function resolveRerankerTokenWithSource(
  opts: TokenResolveOptions = {}
): Promise<ResolvedRerankerToken | null> {
  const env = opts.env ?? process.env;
  if (env.TYPESAFE_API_KEY) return { token: env.TYPESAFE_API_KEY, source: "env" };

  const path = rerankerTokenPath(opts.dataDir);
  try {
    const raw = await Bun.file(path).text();
    const parsed = JSON.parse(raw) as { token?: unknown };
    if (typeof parsed.token === "string" && parsed.token.length > 0) {
      return { token: parsed.token, source: "file", path };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve just the token — a thin wrapper over {@link resolveRerankerTokenWithSource}
 * for the many callers that only need the value, not its provenance.
 */
export async function resolveRerankerToken(opts: TokenResolveOptions = {}): Promise<string | null> {
  const resolved = await resolveRerankerTokenWithSource(opts);
  return resolved?.token ?? null;
}

/**
 * Write the token file, chmod'd to 0600 explicitly after write — `Bun.write`
 * has no mode option, and the token must never be group/world-readable.
 */
export async function writeRerankerToken(dataDir: string, token: string): Promise<void> {
  const { mkdir, chmod } = await import("node:fs/promises");
  const path = rerankerTokenPath(dataDir);
  await mkdir(dataDir, { recursive: true });
  await Bun.write(path, `${JSON.stringify({ token }, null, 2)}\n`);
  await chmod(path, 0o600);
}

/** Delete the token file. A no-op (never throws) when it does not exist. */
export async function removeRerankerToken(dataDir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(rerankerTokenPath(dataDir), { force: true });
}
