import { JevReranker, type JevRerankerOptions, type Reranker } from "./jev.js";
import { resolveRerankerToken, type TokenResolveOptions } from "./token.js";

export interface RerankerFactoryOptions extends TokenResolveOptions, JevRerankerOptions {}

/**
 * Construct a Jev reranker when a token resolves (env or file); null when
 * opted out. Null means zero network calls from anywhere that wires this in —
 * the whole point of an opt-in feature.
 */
export async function createReranker(opts: RerankerFactoryOptions = {}): Promise<Reranker | null> {
  const token = await resolveRerankerToken(opts);
  if (!token) return null;
  return new JevReranker(token, opts);
}
