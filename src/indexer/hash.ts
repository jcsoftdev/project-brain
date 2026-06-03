/** Compute SHA-256 hex hash of content using Bun.CryptoHasher. */
export function computeHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}
