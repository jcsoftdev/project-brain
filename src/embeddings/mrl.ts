/**
 * Matryoshka Representation Learning (MRL) support.
 *
 * MRL-trained models are optimised so the most important semantic information
 * lands in the EARLIEST dimensions — the loss is computed on nested prefixes
 * during training. Truncating such an embedding is therefore a documented,
 * supported operation, and it is the only lever that shrinks the stored vector
 * column: index quantization (IVF_PQ/RQ) compresses the index, not the table.
 *
 * For a model NOT trained this way, information is spread across all
 * dimensions and a prefix is closer to noise than to a summary. That failure
 * is invisible — searches still return results, just worse ones — so
 * truncation is gated on an explicit allowlist rather than inferred from a
 * dimension mismatch.
 */

/** Models verified as Matryoshka-trained, mapped to their native dimension. */
const MRL_MODELS: Array<{ prefix: string; nativeDim: number }> = [
  // Trained with the loss computed on nested prefixes; supports 32–1024.
  { prefix: "qwen3-embedding", nativeDim: 1024 },
  // Ollama ships v1.5, which is the Matryoshka release; supports 64–768.
  { prefix: "nomic-embed-text", nativeDim: 768 },
];

function lookup(model: string) {
  const name = model.toLowerCase();
  return MRL_MODELS.find((m) => name.startsWith(m.prefix));
}

/** Whether this model's embeddings may be safely truncated. */
export function supportsMrl(model: string): boolean {
  return lookup(model) !== undefined;
}

/** The model's full embedding width, or null when the model is unknown to us. */
export function nativeDimFor(model: string): number | null {
  return lookup(model)?.nativeDim ?? null;
}

/**
 * Truncate an embedding to `dim` and restore unit length.
 *
 * The re-normalisation is not optional. Cosine similarity assumes magnitude 1,
 * and a prefix of a unit vector is not itself a unit vector — omitting this
 * step distorts every score in a way nothing downstream can detect.
 */
export function truncateAndNormalize(vector: number[], dim: number): number[] {
  if (dim > vector.length) {
    throw new Error(
      `cannot expand an embedding: requested ${dim} dims from a ${vector.length}-dim vector`
    );
  }
  if (dim === vector.length) return vector;

  const head = vector.slice(0, dim);
  const norm = Math.sqrt(head.reduce((sum, x) => sum + x * x, 0));
  // An all-zero prefix has no direction to preserve; scaling it is undefined.
  if (norm === 0) return head;
  return head.map((x) => x / norm);
}

/**
 * Decide the embedding width to store, given the model's native width and an
 * optional user request (BRAIN_EMBED_DIM).
 *
 * Every rejection falls back to the native width rather than erroring. A
 * smaller-but-broken index costs far more than the disk it saves, and this
 * runs on the indexing hot path where failing the whole run over a malformed
 * env var would be the worse outcome. Rejections are logged, not silent.
 */
export function resolveEmbedDim(
  model: string,
  nativeDim: number,
  requested: string | undefined
): number {
  if (requested === undefined || requested.trim() === "") return nativeDim;

  const want = Number(requested);
  if (!Number.isInteger(want) || want <= 0) {
    console.warn(`[project-brain] ignoring BRAIN_EMBED_DIM=${requested}: not a positive integer`);
    return nativeDim;
  }
  if (want === nativeDim) return nativeDim;
  if (want > nativeDim) {
    console.warn(
      `[project-brain] ignoring BRAIN_EMBED_DIM=${want}: ${model} produces ${nativeDim} dimensions`
    );
    return nativeDim;
  }
  if (!supportsMrl(model)) {
    console.warn(
      `[project-brain] ignoring BRAIN_EMBED_DIM=${want}: ${model} is not known to be Matryoshka-trained, ` +
        `so a ${want}-dim prefix would degrade retrieval instead of compressing it`
    );
    return nativeDim;
  }
  return want;
}
