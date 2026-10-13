import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { DATA_DIR } from "../constants.js";
import type { EmbeddingClient } from "../types.js";
import type { SkillInfo } from "./discovery.js";

/**
 * Items embedded per request when the vector cache is cold. Small on purpose:
 * the hook calls process.exit as soon as it prints, so each batch is written
 * to disk the moment it lands rather than at the end of a long embed.
 */
export const SKILL_EMBED_BATCH = 16;

/** Time a cold cache may spend warming (past the first batch) before ranking with what exists, so warming never delays the suggestion. */
export const SKILL_WARM_BUDGET_MS = 400;

/**
 * Minimum cosine for a skill to be shortlisted. Calibrated on qwen3-embedding:0.6b
 * against 139 installed skills with Spanish prompts: the right skill scored
 * 0.714-0.797 (lowest: "graba un video del flujo de login para el PR"), while
 * unrelated prompts topped out at 0.47-0.62. 0.67 sits in that gap; below it no
 * skill is a plausible fit, so no Jev call is made.
 */
export const SKILL_MIN_COSINE = 0.67;

/** Past this many cached vectors a save keeps only the current items', so growth across projects and edits stays bounded. */
const MAX_CACHED_VECTORS = 2000;

/** Batches between writes during an unbounded (background) warm. */
const WARM_PERSIST_EVERY = 10;

/** A hung embedding server must not hold a background warm forever. */
export const EMBED_TIMEOUT_MS = 30_000;

/** Precision kept per component in JSON caches — plenty for ranking, and roughly halves the file. */
const VECTOR_DECIMALS = 5;

export interface SharedQuery {
  embeddings: EmbeddingClient;
  /** Embedding of the prompt, computed once by the search path. */
  vector: number[];
}

type Vec = ArrayLike<number>;
type VectorMap = Record<string, Vec>;

export function cosine(a: Vec, b: Vec): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function skillText(skill: SkillInfo): string {
  return `${skill.name}: ${skill.description}`.slice(0, 600);
}

/** path + mtime identifies the file revision; the model is the cache file's name, so a model change starts clean. */
function vectorKey(skill: SkillInfo): string {
  return `${skill.path ?? skill.name}|${skill.mtime ?? 0}`;
}

const safeModel = (model: string): string => model.replace(/[^A-Za-z0-9._-]/g, "_") || "default";

/**
 * Where vectors live. `load` resolves `{}` for a missing file and null for one
 * that exists but cannot be read back: the cache is then unknown, and callers
 * neither rank from it nor write over it.
 */
interface VectorStore {
  load(): Promise<VectorMap | null>;
  save(vectors: VectorMap): Promise<void>;
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === "ENOENT";

function jsonStore(file: string): VectorStore {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(file, "utf-8")) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as VectorMap) : null;
      } catch (err) {
        return isMissing(err) ? {} : null;
      }
    },
    async save(vectors) {
      const rounded = Object.fromEntries(
        Object.entries(vectors).map(([k, v]) => [k, Array.from(v, (x) => Number(x.toFixed(VECTOR_DECIMALS)))])
      );
      await writeFileAtomic(file, JSON.stringify(rounded));
    },
  };
}

/**
 * Compact binary layout, one file so a reader never sees an index that
 * disagrees with its data: `u32 headerLen | header JSON {model, dim, keys} |
 * zero pad to 4 | float32[keys.length * dim]`. Loading is one read and zero-copy
 * Float32Array views, a few ms for thousands of vectors where JSON took tens.
 */
interface BinHeader {
  model: string;
  dim: number;
  keys: string[];
}

function binStore(file: string, model: string): VectorStore {
  return {
    async load() {
      let buf: Buffer;
      try {
        buf = await readFile(file);
      } catch (err) {
        return isMissing(err) ? {} : null;
      }
      try {
        const headerLen = buf.readUInt32LE(0);
        const header = JSON.parse(buf.toString("utf-8", 4, 4 + headerLen)) as BinHeader;
        const dataStart = Math.ceil((4 + headerLen) / 4) * 4;
        if (header.keys.length * header.dim * 4 !== buf.length - dataStart) return null;
        const data = buf.buffer.slice(buf.byteOffset + dataStart, buf.byteOffset + buf.length);
        const out: VectorMap = {};
        header.keys.forEach((k, i) => {
          out[k] = new Float32Array(data, i * header.dim * 4, header.dim);
        });
        return out;
      } catch {
        return null;
      }
    },
    async save(vectors) {
      const entries = Object.entries(vectors);
      const dim = entries[0]?.[1].length ?? 0;
      const kept = entries.filter(([, v]) => v.length === dim);
      const header = Buffer.from(JSON.stringify({ model, dim, keys: kept.map(([k]) => k) } satisfies BinHeader));
      const prefix = Buffer.alloc(Math.ceil((4 + header.length) / 4) * 4);
      prefix.writeUInt32LE(header.length, 0);
      header.copy(prefix, 4);
      const data = new Float32Array(kept.length * dim);
      kept.forEach(([, v], i) => data.set(v as ArrayLike<number>, i * dim));
      await writeFileAtomic(file, Buffer.concat([prefix, Buffer.from(data.buffer)]));
    },
  };
}

/** The raw model name recorded in a binary vector file's header, read without loading the vectors. */
async function binFileModel(file: string): Promise<string | null> {
  try {
    const handle = await open(file, "r");
    try {
      const lenBuf = Buffer.alloc(4);
      await handle.read(lenBuf, 0, 4, 0);
      const headerLen = lenBuf.readUInt32LE(0);
      const head = Buffer.alloc(headerLen);
      await handle.read(head, 0, headerLen, 4);
      const model = (JSON.parse(head.toString("utf-8")) as { model?: unknown }).model;
      return typeof model === "string" ? model : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Models that already have a binary vector file with this prefix — the ones a background warm should keep current. */
export async function modelsWithVectors(filePrefix: string, cacheDir: string = DATA_DIR): Promise<string[]> {
  try {
    const files = (await readdir(cacheDir)).filter((f) => f.startsWith(`${filePrefix}-`) && f.endsWith(".bin"));
    const models = await Promise.all(files.map((f) => binFileModel(join(cacheDir, f))));
    return [...new Set(models.filter((m): m is string => m !== null))];
  } catch {
    return [];
  }
}

/** What differs between ranking skills and ranking tools: the text embedded, the cache identity, the file format, and whether the hook may embed. */
export interface RankSpec<T> {
  /** Vector cache file prefix: `skill-vectors`, `tool-vectors`. */
  filePrefix: string;
  text: (item: T) => string;
  key: (item: T) => string;
  /** `bin` for large catalogs (tools), `json` for small ones (skills). */
  format: "json" | "bin";
  /** Whether the prompt hook may embed missing items (within the warm budget). Off → rank only with vectors that exist. */
  warmOnHook: boolean;
}

function openStore<T>(spec: RankSpec<T>, cacheDir: string, model: string): VectorStore {
  const base = join(cacheDir, `${spec.filePrefix}-${safeModel(model)}`);
  return spec.format === "bin" ? binStore(`${base}.bin`, model) : jsonStore(`${base}.json`);
}

async function embedWithTimeout(embeddings: EmbeddingClient, texts: string[]): Promise<number[][] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      embeddings.embed(texts),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), EMBED_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embeds the items that have no cached vector, a batch at a time, persisting
 * as it goes. `budgetMs` bounds time spent past the first batch. `pruneToItems`
 * saves only the current items' vectors; otherwise that happens only past
 * {@link MAX_CACHED_VECTORS}.
 */
async function fillVectors<T>(
  items: T[],
  spec: RankSpec<T>,
  embeddings: EmbeddingClient,
  vectors: VectorMap,
  store: VectorStore,
  now: () => number,
  budgetMs: number,
  pruneToItems: boolean
): Promise<void> {
  const missing = items.filter((s) => !vectors[spec.key(s)]);
  const persist = async (): Promise<void> => {
    let toSave = vectors;
    if (pruneToItems || Object.keys(vectors).length > MAX_CACHED_VECTORS) {
      toSave = Object.fromEntries(items.flatMap((s) => (vectors[spec.key(s)] ? [[spec.key(s), vectors[spec.key(s)]!] as const] : [])));
    }
    try {
      await store.save(toSave);
    } catch {
      // Unwritable cache → re-embed next time.
    }
  };

  const warmStart = now();
  let unsaved = false;
  for (let i = 0; i < missing.length; i += SKILL_EMBED_BATCH) {
    if (i > 0 && now() - warmStart >= budgetMs) break;
    const batch = missing.slice(i, i + SKILL_EMBED_BATCH);
    const embedded = await embedWithTimeout(embeddings, batch.map(spec.text));
    if (!embedded || embedded.length !== batch.length) break;
    batch.forEach((s, j) => {
      vectors[spec.key(s)] = embedded[j]!;
    });
    unsaved = true;
    // The hook may be cut off at any moment, so it persists every batch; an
    // unbounded warm would rewrite a multi-MB file ~80 times, so it persists in steps.
    if (budgetMs !== Number.POSITIVE_INFINITY || (i / SKILL_EMBED_BATCH) % WARM_PERSIST_EVERY === WARM_PERSIST_EVERY - 1) {
      await persist();
      unsaved = false;
    }
  }
  const retained = items.filter((s) => vectors[spec.key(s)]).length;
  if (unsaved || (pruneToItems && Object.keys(vectors).length > retained)) await persist();
}

/**
 * Embeds every uncached item and drops vectors of items no longer present —
 * for background refreshes, never the hook. A cache file that cannot be read
 * back is left alone. Never throws.
 */
export async function warmVectors<T>(items: T[], spec: RankSpec<T>, embeddings: EmbeddingClient, cacheDir: string = DATA_DIR): Promise<void> {
  try {
    const store = openStore(spec, cacheDir, embeddings.model ?? "");
    const vectors = await store.load();
    if (vectors === null) return;
    await fillVectors(items, spec, embeddings, vectors, store, Date.now, Number.POSITIVE_INFINITY, true);
  } catch {
    // Warming is best-effort.
  }
}

/**
 * Top `topN` items by cosine to the prompt vector that clear
 * {@link SKILL_MIN_COSINE} ([] when none do), or null when embeddings can't
 * help (no vectors for any item, or a cache that can't be read) so the caller
 * falls back to keywords. Vectors are cached on disk by `spec.key` + model.
 * When `spec.warmOnHook`, a cold cache is warmed {@link SKILL_EMBED_BATCH}
 * items at a time, persisted per batch, for at most {@link SKILL_WARM_BUDGET_MS};
 * otherwise only existing vectors are used. Never throws.
 */
export async function rankSemantic<T>(
  items: T[],
  spec: RankSpec<T>,
  query: SharedQuery,
  topN: number,
  cacheDir: string = DATA_DIR,
  now: () => number = Date.now
): Promise<T[] | null> {
  try {
    const store = openStore(spec, cacheDir, query.embeddings.model ?? "");
    const vectors = await store.load();
    if (vectors === null) return null;
    if (spec.warmOnHook) await fillVectors(items, spec, query.embeddings, vectors, store, now, SKILL_WARM_BUDGET_MS, false);

    const scored = items
      .filter((s) => vectors[spec.key(s)])
      .map((s) => ({ item: s, score: cosine(query.vector, vectors[spec.key(s)]!) }))
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return null;
    return scored.filter((s) => s.score >= SKILL_MIN_COSINE).slice(0, topN).map((s) => s.item);
  } catch {
    return null;
  }
}

const SKILL_SPEC: RankSpec<SkillInfo> = { filePrefix: "skill-vectors", text: skillText, key: vectorKey, format: "json", warmOnHook: true };

/** {@link rankSemantic} over installed skills. */
export function rankSkillsSemantic(
  skills: SkillInfo[],
  query: SharedQuery,
  topN: number,
  cacheDir: string = DATA_DIR,
  now: () => number = Date.now
): Promise<SkillInfo[] | null> {
  return rankSemantic(skills, SKILL_SPEC, query, topN, cacheDir, now);
}
