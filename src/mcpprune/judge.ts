import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { resolveRerankerToken } from "../rerank/token.js";
import { collapse } from "../toolcatalog/live.js";
import { askDetailed, type NoulQuestion, type TypesafeFetchFn } from "../typesafe/client.js";

/** How prune reaches Jev; absent means usage history alone decides, as before Jev took part. */
export interface JevSettings {
  token: string;
  fetchFn?: TypesafeFetchFn;
  timeoutMs?: number;
}

/** What Jev reads about one server: never its command, arguments, URL or environment. */
export interface ServerBrief {
  name: string;
  tools: string[];
  instructions?: string;
}

/** Prune runs offline, so it can wait longer than a prompt hook. */
const TIMEOUT_MS = 8_000;
const README_CHARS = 1_500;
const INSTRUCTIONS_CHARS = 600;
const MAX_TOOLS = 40;
const MAX_ENTRIES = 40;
/** Answers older than this are asked again: a project's direction drifts. */
const CACHE_TTL_MS = 30 * 86_400_000;

const cachePath = (dataDir: string) => join(dataDir, "mcp-prune-jev.json");

/** Token from `TYPESAFE_API_KEY` or `reranker.json`, unless `PROJECT_BRAIN_MCP_PRUNE_JEV=0`. Never throws. */
export async function jevFromProcess(dataDir: string): Promise<JevSettings | null> {
  if (process.env.PROJECT_BRAIN_MCP_PRUNE_JEV === "0") return null;
  const token = await resolveRerankerToken({ dataDir }).catch(() => null);
  return token ? { token } : null;
}

const readText = (path: string) => readFile(path, "utf-8").catch(() => null);

/** README head, package manifest basics and top-level names: enough to tell a game from a web shop. */
export async function describeProject(dir: string): Promise<Record<string, unknown>> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const readmeName = entries.find((n) => /^readme(\.md|\.txt)?$/i.test(n));
  const readme = readmeName ? await readText(join(dir, readmeName)) : null;
  const brief: Record<string, unknown> = {
    name: basename(dir),
    files: entries.filter((n) => !n.startsWith(".") || n === ".mcp.json").sort().slice(0, MAX_ENTRIES),
  };
  if (readme) brief.readme = collapse(readme).slice(0, README_CHARS);
  try {
    const pkg = JSON.parse((await readText(join(dir, "package.json"))) ?? "") as Record<string, unknown>;
    const deps = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : []);
    brief.package = {
      ...(typeof pkg.name === "string" ? { name: pkg.name } : {}),
      ...(typeof pkg.description === "string" ? { description: pkg.description } : {}),
      dependencies: [...deps(pkg.dependencies), ...deps(pkg.devDependencies)].slice(0, MAX_ENTRIES),
    };
  } catch {
    // No manifest, or not JSON: the rest still describes the project.
  }
  return brief;
}

interface CacheEntry {
  key: string;
  at: number;
  needed: Record<string, number>;
}

async function loadCache(dataDir: string): Promise<Record<string, CacheEntry>> {
  try {
    const raw = JSON.parse((await readText(cachePath(dataDir))) ?? "") as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, CacheEntry>) : {};
  } catch {
    return {};
  }
}

export interface JudgeRequest {
  dataDir: string;
  jev: JevSettings;
  now: number;
  /** The repo the answers are cached under; its worktrees share them. */
  repo: string;
  project: Record<string, unknown>;
  servers: ServerBrief[];
}

export interface JudgeResult {
  /** Server name → probability (0..1) that the project will call it. */
  needed: Map<string, number>;
  /** False when every answer came from the cache. */
  asked: boolean;
}

/**
 * Asks Jev, in one request, how likely the project is to need each server. Answers
 * are cached per repo and reused while the project description is unchanged, so a
 * prune run that plans twice (setup inspects, then applies) asks once. Null on any
 * failure, which callers treat as "no opinion". Never throws, never logs the token.
 */
export async function judgeServers(req: JudgeRequest): Promise<JudgeResult | null> {
  try {
    const key = createHash("sha1").update(JSON.stringify(req.project)).digest("hex");
    const cache = await loadCache(req.dataDir);
    const hit = cache[req.repo];
    const fresh = hit && hit.key === key && req.now - hit.at < CACHE_TTL_MS ? hit.needed : {};
    const missing = req.servers.filter((s) => typeof fresh[s.name] !== "number");
    if (missing.length === 0) return { needed: new Map(req.servers.map((s) => [s.name, fresh[s.name]!])), asked: false };

    const servers: Record<string, unknown> = {};
    const questions: Record<string, NoulQuestion> = {};
    missing.forEach((s, i) => {
      servers[`s${i}`] = {
        name: s.name,
        tools: s.tools.slice(0, MAX_TOOLS),
        ...(s.instructions ? { instructions: collapse(s.instructions).slice(0, INSTRUCTIONS_CHARS) } : {}),
      };
      questions[`s${i}`] = {
        type: "noul",
        instructions:
          `A developer working in \`project\` will call tools of the MCP server \`servers.s${i}\` ` +
          `during their coding sessions there: what the server does fits the work this project involves.`,
      };
    });
    const outcome = await askDetailed(req.jev.token, { project: req.project, servers }, questions, {
      fetchFn: req.jev.fetchFn,
      timeoutMs: req.jev.timeoutMs ?? TIMEOUT_MS,
    });
    if (!outcome.ok) return null;

    const answered = Object.fromEntries(missing.map((s, i) => [s.name, outcome.answers[`s${i}`]!.noul]));
    const needed = { ...fresh, ...answered };
    cache[req.repo] = { key, at: req.now, needed };
    await writeFileAtomic(cachePath(req.dataDir), `${JSON.stringify(cache, null, 2)}\n`).catch(() => {});
    return { needed: new Map(req.servers.map((s) => [s.name, needed[s.name]!])), asked: true };
  } catch {
    return null;
  }
}
