/** Result of the auto-tuning heuristic: what to use, and why (surfaced to the user). */
export interface EmbedTuning {
  batchSize: number;
  concurrency: number;
  reason: string;
}

/** Machine-observable inputs the heuristic reasons over. Pure data — no I/O. */
export interface MachineSnapshot {
  /** os.cpus().length */
  cores: number;
  /** os.freemem() */
  freeMemBytes: number;
  /** Another (non-embedding) model is currently loaded in Ollama — VRAM contention risk. */
  ollamaBusy: boolean;
}

const GIB = 1024 ** 3;
const LOW_MEMORY_THRESHOLD_BYTES = 4 * GIB;

/**
 * Pure heuristic — fully unit-testable, no I/O. Decides batch size and
 * concurrency for embedding requests from a machine resource snapshot.
 */
export function computeEmbedTuning(snap: MachineSnapshot): EmbedTuning {
  // Rule 1 (checked first — takes priority over memory): VRAM contention.
  // Another model besides the embed model is loaded in Ollama. This is the
  // exact failure observed live: with a second model sharing the GPU,
  // concurrency=3 causes Ollama to choke (request timeouts / crashes).
  // Serialize requests and shrink the batch to reduce pressure on the
  // shared llama-server.
  if (snap.ollamaBusy) {
    return { batchSize: 16, concurrency: 1, reason: "vram-contention" };
  }

  // Rule 2: memory-constrained host. Large batches balloon this process's
  // own heap (pending chunk text + embedding response buffers held in
  // memory at once). Below 4 GiB free, shrink the batch and serialize to
  // avoid OOM/swap thrash on the host running project-brain itself.
  if (snap.freeMemBytes < LOW_MEMORY_THRESHOLD_BYTES) {
    return { batchSize: 32, concurrency: 1, reason: "low-memory" };
  }

  // Rule 3: default/healthy host. Embedding inference against a single
  // local Ollama instance is GPU-compute-bound, not I/O-bound — there is
  // no idle time between concurrent requests for the runtime to overlap
  // into (verified live: 3 concurrent /api/embed calls finish in 2.82s
  // serialized vs 3.3s with true parallelism forced via
  // OLLAMA_NUM_PARALLEL=4 — concurrency>1 has no throughput upside here,
  // only the downside of false timeouts under queuing and circuit-breaker
  // churn, which is what caused "[sync] Embedding under load failed at
  // concurrency=3" to fire reliably on any 12+ core machine). Scaling by
  // core count was the wrong model for this workload — cores are no
  // longer a factor.
  return { batchSize: 64, concurrency: 1, reason: `default cores=${snap.cores}` };
}

/** Timeout for the Ollama /api/ps contention probe — must never stall a sync run. */
const PROBE_TIMEOUT_MS = 500;

/**
 * I/O wrapper around computeEmbedTuning: reads machine resources (os.*) and
 * probes Ollama's /api/ps to detect VRAM contention (another model loaded
 * besides the embed model). Fail-open on ANY probe error/timeout — assumes
 * no contention rather than aborting the caller's sync run. Never throws.
 */
export async function detectEmbedTuning(host: string, embedModel: string): Promise<EmbedTuning> {
  const os = await import("node:os");

  let ollamaBusy = false;
  try {
    const response = await fetch(`${host}/api/ps`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      const data = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
      const models = Array.isArray(data.models) ? data.models : [];
      ollamaBusy = models.some((m) => (m.name ?? m.model) !== embedModel);
    }
  } catch {
    // Fail-open: unreachable host, timeout, or malformed response must never
    // throw or block the sync run — fall back to resource-only heuristics
    // (ollamaBusy=false) below, same as a healthy/idle Ollama.
    ollamaBusy = false;
  }

  return computeEmbedTuning({
    cores: os.cpus().length,
    freeMemBytes: os.freemem(),
    ollamaBusy,
  });
}
