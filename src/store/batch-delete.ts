/**
 * Build `source IN (...)` predicates for deleting many chunks at once.
 *
 * Every lance `delete()` is a transaction, and every transaction writes a
 * version manifest listing the table's fragments. Deleting one source at a
 * time therefore costs one version PER FILE: a sweep that removed 58,189
 * vendored files grew _versions from 16,070 to 78,786 manifests and 5GB, on a
 * table holding roughly 200MB of real content.
 *
 * Batching turns that from O(files) into O(files / batchSize).
 */

/** Sources per predicate. Large enough to matter, small enough that the
 *  predicate string stays well within any engine-side statement limit. */
export const DELETE_BATCH_SIZE = 500;

export function buildSourcePredicates(
  sources: string[],
  batchSize: number = DELETE_BATCH_SIZE
): string[] {
  // An empty list must yield NO predicate. `source IN ()` is either a syntax
  // error or something that matches more than intended — never a safe delete.
  if (sources.length === 0) return [];

  const size = batchSize > 0 ? batchSize : sources.length;
  const out: string[] = [];

  for (let i = 0; i < sources.length; i += size) {
    const batch = sources.slice(i, i + size);
    const quoted = batch.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
    out.push(`source IN (${quoted})`);
  }

  return out;
}
