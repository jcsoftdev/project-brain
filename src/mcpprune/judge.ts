import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { featureEnabled } from "../features.js";
import { detectStack } from "../indexer/stack.js";
import { resolveRerankerToken } from "../rerank/token.js";
import { askDetailed, type NoulQuestion, type TypesafeFetchFn } from "../typesafe/client.js";

/** How prune reaches Jev; absent means usage history alone decides, as before Jev took part. */
export interface JevSettings {
  token: string;
  fetchFn?: TypesafeFetchFn;
  timeoutMs?: number;
}

/** One server as prune knows it. Only `name` and `tools` are ever sent; `instructions` feeds the local cache key alone. */
export interface ServerBrief {
  name: string;
  tools: string[];
  instructions?: string;
}

/** Structured, low-risk signals only: no README text, no file names, no package name, no scoped dependency. */
export interface ProjectSignals {
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  dependencies: string[];
}

/** Per request; the run as a whole is bounded by {@link JudgeRun.deadline}. */
const TIMEOUT_MS = 8_000;
const MAX_TOOLS = 40;
const MAX_DEPENDENCIES = 60;
/** Answers older than this are asked again: a project's direction drifts. */
const CACHE_TTL_MS = 30 * 86_400_000;
/** A repo whose request failed is not asked again for this long, so a dead network does not keep setup busy. */
const FAILURE_TTL_MS = 86_400_000;

const cachePath = (dataDir: string) => join(dataDir, "mcp-prune-jev.json");

/**
 * Token from `TYPESAFE_API_KEY` or `reranker.json`, only when the opt-in `mcp-prune-jev`
 * feature is on (ticked in setup, or `PROJECT_BRAIN_MCP_PRUNE_JEV=1`). Never throws.
 */
export async function jevFromProcess(dataDir: string): Promise<JevSettings | null> {
  if (!featureEnabled("mcp-prune-jev", dataDir)) return null;
  const token = await resolveRerankerToken({ dataDir }).catch(() => null);
  return token ? { token } : null;
}

/**
 * Stack and public dependency names: enough to tell a game from a web shop. Scoped names
 * (`@org/...`) are left out because private packages live under scopes; the package's own
 * name is never read.
 */
export async function projectSignals(dir: string): Promise<ProjectSignals> {
  const stack = await detectStack(dir).catch(() => ({ languages: [], frameworks: [], packageManager: null, manifest: null }));
  const signals: ProjectSignals = {
    languages: stack.languages,
    frameworks: stack.frameworks,
    packageManager: stack.packageManager,
    dependencies: [],
  };
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8")) as Record<string, unknown>;
    const names = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : []);
    signals.dependencies = [...names(pkg.dependencies), ...names(pkg.devDependencies)]
      .filter((n) => !n.startsWith("@"))
      .sort()
      .slice(0, MAX_DEPENDENCIES);
  } catch {
    // No manifest, or not JSON: the stack still describes the project.
  }
  return signals;
}

/** A brief worth sending: the server announced tools. One without is kept, never judged by its name alone. */
export const judgeable = (s: ServerBrief): boolean => s.tools.length > 0;

const hash = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);

const answerKey = (repo: string, project: ProjectSignals, server: ServerBrief) =>
  `${repo}\u0000${hash(project)}\u0000${hash([server.name, server.tools.slice(0, MAX_TOOLS), server.instructions ?? ""])}`;

interface CacheFile {
  answers: Record<string, { at: number; needed: number }>;
  failed: Record<string, number>;
}

async function loadCache(dataDir: string): Promise<CacheFile> {
  try {
    const raw = JSON.parse(await readFile(cachePath(dataDir), "utf-8")) as Partial<CacheFile>;
    const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    return { answers: record(raw.answers) as CacheFile["answers"], failed: record(raw.failed) as CacheFile["failed"] };
  } catch {
    return { answers: {}, failed: {} };
  }
}

/** Answers this process already got, so a lost cache write does not cost a second request within one run. */
const memory: CacheFile = { answers: {}, failed: {} };

/** Merges into whatever is on disk right before the rename, so concurrent runs keep each other's entries. */
async function remember(dataDir: string, update: Partial<CacheFile>): Promise<void> {
  Object.assign(memory.answers, update.answers);
  Object.assign(memory.failed, update.failed);
  try {
    const disk = await loadCache(dataDir);
    const merged: CacheFile = { answers: { ...disk.answers, ...update.answers }, failed: { ...disk.failed, ...update.failed } };
    for (const repo of Object.keys(update.answers ?? {}).map((k) => k.split("\u0000")[0]!)) delete merged.failed[repo];
    await writeFileAtomic(cachePath(dataDir), `${JSON.stringify(merged, null, 2)}\n`);
  } catch {
    // The in-process copy still serves this run.
  }
}

/** One prune run's budget: how many requests it may make and until when. */
export interface JudgeRun {
  jev: JevSettings;
  dataDir: string;
  now: number;
  /** False: answer from the cache only, with no request and no write (status, dry runs). */
  ask: boolean;
  /** Wall-clock ms after which no request starts; unanswered servers are kept. */
  deadline: number;
  requestsLeft: number;
}

export type Verdict =
  /** Probability per judged server; servers missing from the map are kept. */
  | { needed: Map<string, number> }
  /** The cache cannot answer and this run may not ask. */
  | { pending: true }
  /** Jev failed, recently failed, or the run's budget is spent: keep everything. */
  | null;

/**
 * How likely the project is to need each server, from the cache or, when the run
 * may ask, from one Jev request covering every server the cache cannot answer.
 * Never throws, never logs the token.
 */
export async function judgeServers(run: JudgeRun, repo: string, project: ProjectSignals, servers: ServerBrief[]): Promise<Verdict> {
  try {
    const disk = await loadCache(run.dataDir);
    const cached = (k: string) =>
      [memory.answers[k], disk.answers[k]].find((a) => a && typeof a.needed === "number" && run.now - a.at < CACHE_TTL_MS);
    const keys = new Map(servers.map((s) => [s.name, answerKey(repo, project, s)]));
    const needed = new Map<string, number>();
    for (const s of servers) {
      const hit = cached(keys.get(s.name)!);
      if (hit) needed.set(s.name, hit.needed);
    }
    const missing = servers.filter((s) => !needed.has(s.name));
    if (missing.length === 0) return { needed };
    const failedAt = Math.max(memory.failed[repo] ?? 0, disk.failed[repo] ?? 0);
    if (run.now - failedAt < FAILURE_TTL_MS) return null;
    if (!run.ask) return { pending: true };
    const remaining = run.deadline - Date.now();
    if (run.requestsLeft <= 0 || remaining <= 0) return null;
    run.requestsLeft--;

    const state: Record<string, unknown> = { project };
    const questions: Record<string, NoulQuestion> = {};
    const briefs: Record<string, unknown> = {};
    missing.forEach((s, i) => {
      briefs[`s${i}`] = { name: s.name, tools: s.tools.slice(0, MAX_TOOLS) };
      questions[`s${i}`] = {
        type: "noul",
        instructions:
          `A developer working in \`project\` will call tools of the MCP server \`servers.s${i}\` ` +
          `during their coding sessions there: what the server does fits the work this project involves.`,
      };
    });
    state.servers = briefs;
    const outcome = await askDetailed(run.jev.token, state, questions, {
      fetchFn: run.jev.fetchFn,
      timeoutMs: Math.min(run.jev.timeoutMs ?? TIMEOUT_MS, remaining),
    });
    if (!outcome.ok) {
      await remember(run.dataDir, { failed: { [repo]: run.now } });
      return null;
    }
    const answers: CacheFile["answers"] = {};
    missing.forEach((s, i) => {
      const p = outcome.answers[`s${i}`]!.noul;
      needed.set(s.name, p);
      answers[keys.get(s.name)!] = { at: run.now, needed: p };
    });
    await remember(run.dataDir, { answers });
    return { needed };
  } catch {
    return null;
  }
}
