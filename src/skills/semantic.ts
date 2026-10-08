import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../constants.js";
import type { EmbeddingClient } from "../types.js";
import type { SkillInfo } from "./discovery.js";

/**
 * Skills embedded per request when the vector cache is cold. Small on purpose:
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

/** Vector cache entries kept before the file is reset; bounds growth across projects and edits. */
const MAX_CACHED_VECTORS = 2000;

/** Precision kept per component — plenty for ranking, and roughly halves the file. */
const VECTOR_DECIMALS = 5;

export interface SharedQuery {
  embeddings: EmbeddingClient;
  /** Embedding of the prompt, computed once by the search path. */
  vector: number[];
}

export function cosine(a: number[], b: number[]): number {
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

function cachePath(cacheDir: string, model: string): string {
  return join(cacheDir, `skill-vectors-${model.replace(/[^A-Za-z0-9._-]/g, "_") || "default"}.json`);
}

async function loadVectors(file: string): Promise<Record<string, number[]>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number[]>) : {};
  } catch {
    return {};
  }
}

const round = (v: number[]): number[] => v.map((x) => Number(x.toFixed(VECTOR_DECIMALS)));

/**
 * Top `topN` skills by cosine to the prompt vector that clear
 * {@link SKILL_MIN_COSINE} ([] when none do), or null when embeddings can't
 * help (no vectors for any skill) so the caller falls back to keywords.
 * Skill vectors are cached on disk by path + mtime + model; a cold cache is
 * warmed {@link SKILL_EMBED_BATCH} skills at a time, persisted per batch, for
 * at most {@link SKILL_WARM_BUDGET_MS}. Never throws.
 */
export async function rankSkillsSemantic(
  skills: SkillInfo[],
  query: SharedQuery,
  topN: number,
  cacheDir: string = DATA_DIR,
  now: () => number = Date.now
): Promise<SkillInfo[] | null> {
  try {
    const file = cachePath(cacheDir, query.embeddings.model ?? "");
    let vectors = await loadVectors(file);
    if (Object.keys(vectors).length > MAX_CACHED_VECTORS) vectors = {};

    const missing = skills.filter((s) => !vectors[vectorKey(s)]);
    const warmStart = now();
    for (let i = 0; i < missing.length; i += SKILL_EMBED_BATCH) {
      if (i > 0 && now() - warmStart >= SKILL_WARM_BUDGET_MS) break;
      const batch = missing.slice(i, i + SKILL_EMBED_BATCH);
      const embedded = await query.embeddings.embed(batch.map(skillText));
      if (!embedded || embedded.length !== batch.length) break;
      batch.forEach((s, j) => {
        vectors[vectorKey(s)] = round(embedded[j]!);
      });
      try {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(file, JSON.stringify(vectors));
      } catch {
        // Unwritable cache → re-embed next time.
      }
    }

    const scored = skills
      .filter((s) => vectors[vectorKey(s)])
      .map((s) => ({ skill: s, score: cosine(query.vector, vectors[vectorKey(s)]!) }))
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return null;
    return scored.filter((s) => s.score >= SKILL_MIN_COSINE).slice(0, topN).map((s) => s.skill);
  } catch {
    return null;
  }
}
