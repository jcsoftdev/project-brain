import { JevReranker, type JevRerankerOptions, type Reranker } from "./jev.js";
import { resolveRerankerTokenWithSource, type RerankerTokenSource, type TokenResolveOptions } from "./token.js";

export interface RerankerFactoryOptions extends TokenResolveOptions, JevRerankerOptions {}

export interface RerankerWithSource {
  reranker: Reranker;
  source: RerankerTokenSource;
  /** Set only when source is "file". Never the token itself. */
  path?: string;
}

/**
 * Construct a Jev reranker when a token resolves (env or file), plus WHERE
 * the token came from — used by health/help for Jev status discoverability.
 * Null when opted out: zero network calls from anywhere that wires this in.
 */
export async function createRerankerWithSource(
  opts: RerankerFactoryOptions = {}
): Promise<RerankerWithSource | null> {
  const resolved = await resolveRerankerTokenWithSource(opts);
  if (!resolved) return null;
  return { reranker: new JevReranker(resolved.token, opts), source: resolved.source, path: resolved.path };
}

/**
 * Construct a Jev reranker when a token resolves (env or file); null when
 * opted out. Thin wrapper over {@link createRerankerWithSource} for callers
 * that only need the reranker, not its token's provenance.
 */
export async function createReranker(opts: RerankerFactoryOptions = {}): Promise<Reranker | null> {
  const result = await createRerankerWithSource(opts);
  return result?.reranker ?? null;
}
