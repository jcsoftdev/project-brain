/**
 * Calibration for the prompt-context hook's score floor (HOOK_MIN_SCORE). Replays real prompts from
 * Claude Code transcripts READ-ONLY, runs the hook's own retrieval + Jev rerank for each, and writes
 * every candidate hit to a file OUTSIDE the repository, because it holds prompt text. A human (or an
 * agent) then labels each hit, and the report prints precision/recall of "injected" per floor.
 *
 *   bun scripts/calibrate-hook-floor.ts [--max 30] [--files 40] [--out <hits.json>] [--dry]
 *   bun scripts/calibrate-hook-floor.ts --report --labels <labels.json> [--out <hits.json>]
 *
 * labels.json maps a hit id from hits.json (`p3h2`) to true (would help answer the prompt) or false.
 * Prompts come from the project-brain transcripts first, plus a few from other indexed projects, and
 * the hook's own non-code prompt filter drops what the hook would never search for.
 *
 * Hard cap: one Jev request per prompt, never more than 30, whatever --max says.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DB_PATH, OLLAMA_HOST } from "../src/constants.js";
import { formatHit, HOOK_MAX_HITS, HOOK_MIN_SCORE, type Hit } from "../src/commands/search.js";
import { isNonCodePrompt } from "../src/commands/trivial-prompt.js";
import { createEmbeddingClient } from "../src/embeddings/factory.js";
import { createReranker } from "../src/rerank/factory.js";
import type { Reranker } from "../src/rerank/jev.js";
import { estimateTokens } from "../src/retrieval/budget.js";
import { LanceDbStore } from "../src/store/lancedb.js";
import { readTableMeta } from "../src/store/meta.js";
import { handleSearch } from "../src/tools/search.js";

const HARD_CAP = 30;
const HOME_PROJECT = "project-brain";
const OTHER_SHARE = 0.25;
/** The hook's own `--limit` default in src/commands/search.ts execute(). */
const HOOK_LIMIT = 8;
const FLOORS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85];

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const num = (name: string, fallback: number) => (Number(arg(name)) > 0 ? Number(arg(name)) : fallback);
const max = Math.min(num("max", HARD_CAP), HARD_CAP);
const fileLimit = num("files", 40);
const outPath = arg("out") ?? join(tmpdir(), "project-brain-hook-floor", "hits.json");

interface Case {
  id: string;
  project: string;
  prompt: string;
}
interface CaseResult extends Case {
  ok: boolean;
  hits: Array<Hit & { id: string; tokens: number }>;
}

type Line = { type?: string; isMeta?: boolean; isSidechain?: boolean; cwd?: string; message?: { content?: unknown } };

/** A prompt the user typed as plain string content; null for tool results, wrappers and harness frames. */
function typed(line: Line): string | null {
  if (line.type !== "user" || line.isMeta || line.isSidechain) return null;
  const content = line.message?.content;
  if (typeof content !== "string") return null;
  const text = content.trim();
  if (!text || text.startsWith("<") || /<(system-reminder|task-notification|local-command-)/.test(text)) return null;
  return isNonCodePrompt(text) ? null : text;
}

const projectIds = new Map<string, string | null>();
async function projectFor(cwd: string | undefined): Promise<string | null> {
  if (!cwd) return null;
  if (!projectIds.has(cwd)) {
    let id: string | null = null;
    try {
      const raw = JSON.parse(await readFile(join(cwd, ".project-brain", "project.json"), "utf8")) as { projectId?: string };
      if (raw.projectId && (await readTableMeta(DB_PATH, raw.projectId))) id = raw.projectId;
    } catch {
      // Not an indexed project: the hook would find nothing there either.
    }
    projectIds.set(cwd, id);
  }
  return projectIds.get(cwd) ?? null;
}

/** Stable pseudo-random order, so a rerun on the same transcripts picks the same prompts. */
const rank = (s: string) => createHash("sha1").update(s).digest("hex");

async function candidates(root: string): Promise<Map<string, Case[]>> {
  const byProject = new Map<string, Case[]>();
  const seen = new Set<string>();
  for (const dir of await readdir(root).catch(() => [])) {
    const files: Array<{ path: string; mtime: number }> = [];
    for (const name of await readdir(join(root, dir)).catch(() => [])) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(root, dir, name);
      files.push({ path, mtime: (await stat(path)).mtimeMs });
    }
    for (const f of files.sort((a, b) => b.mtime - a.mtime).slice(0, fileLimit)) {
      for (const raw of (await readFile(f.path, "utf8")).split("\n")) {
        if (!raw.trim()) continue;
        let line: Line;
        try {
          line = JSON.parse(raw) as Line;
        } catch {
          continue;
        }
        const prompt = typed(line);
        if (prompt === null || seen.has(prompt)) continue;
        const project = await projectFor(line.cwd);
        if (!project) continue;
        seen.add(prompt);
        byProject.set(project, [...(byProject.get(project) ?? []), { id: "", project, prompt }]);
      }
    }
  }
  return byProject;
}

/** Mostly the home project, the rest spread round-robin over the other indexed projects. */
function select(byProject: Map<string, Case[]>): Case[] {
  const ordered = (cases: Case[]) => [...cases].sort((a, b) => rank(a.prompt).localeCompare(rank(b.prompt)));
  const others = [...byProject.keys()].filter((p) => p !== HOME_PROJECT).sort().map((p) => ordered(byProject.get(p)!));
  const otherTarget = Math.min(Math.round(max * OTHER_SHARE), others.reduce((n, c) => n + c.length, 0));
  const picked: Case[] = [];
  for (let round = 0; picked.length < otherTarget; round++) {
    for (const cases of others) if (cases[round] && picked.length < otherTarget) picked.push(cases[round]!);
  }
  const home = ordered(byProject.get(HOME_PROJECT) ?? []).slice(0, max - picked.length);
  return [...home, ...picked].map((c, i) => ({ ...c, id: `p${i}` }));
}

/** Counts every request, so the cap is checked against what was actually sent. */
function counting(inner: Reranker, budget: { used: number; answered: number }): Reranker {
  return {
    rerank: async (query, cands) => {
      if (budget.used >= max) return null;
      budget.used++;
      const scores = await inner.rerank(query, cands);
      if (scores) budget.answered++;
      return scores;
    },
  };
}

async function collect(): Promise<void> {
  const byProject = await candidates(join(homedir(), ".claude", "projects"));
  const cases = select(byProject);
  const perProject = [...new Set(cases.map((c) => c.project))].map((p) => `${p}=${cases.filter((c) => c.project === p).length}`);
  console.log(`indexed projects with prompts: ${byProject.size}; selected ${cases.length} (cap ${max}): ${perProject.join(", ")}`);
  if (process.argv.includes("--dry")) return;

  // Same factory the hook uses; a longer timeout so a slow answer does not waste a capped request.
  const jev = await createReranker({ timeoutMs: 15_000 });
  if (!jev) {
    console.log("no TypeSafe token available: no requests made");
    return;
  }
  const budget = { used: 0, answered: 0 };
  const reranker = counting(jev, budget);
  const store = new LanceDbStore(DB_PATH);
  const results: CaseResult[] = [];

  for (const c of cases) {
    if (budget.used >= max) break;
    const meta = await readTableMeta(DB_PATH, c.project);
    const embeddings = await createEmbeddingClient(meta?.model, { host: OLLAMA_HOST, autoPull: false, lane: "interactive", recordedDim: meta?.dim });
    const before = budget.answered;
    const result = await handleSearch({ project: c.project, query: c.prompt, limit: HOOK_LIMIT }, { store, embeddings, reranker });
    const hits = result.isError ? [] : ((JSON.parse(result.content[0]!.text) as { results?: Hit[] }).results ?? []);
    // A failed rerank leaves the store's own scores, which the floor does not apply to: excluded from the table.
    const reranked = budget.answered > before;
    results.push({
      ...c,
      ok: !result.isError && reranked,
      hits: hits.map((h, i) => ({ ...h, id: `${c.id}h${i}`, tokens: estimateTokens(formatHit(h)) })),
    });
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(results, null, 2));
  const hitCount = results.reduce((n, r) => n + r.hits.length, 0);
  console.log(`requests: ${budget.used}; answered: ${budget.answered}; prompts with hits: ${results.filter((r) => r.hits.length).length}; hits: ${hitCount}; written to ${outPath}`);
}

const kind = (source: string) =>
  source.startsWith("odd/") ? "odd" : source.startsWith("docs/") || source.endsWith(".md") ? "docs" : source.startsWith("tests/") ? "tests" : "code";

async function report(): Promise<void> {
  const labelsPath = arg("labels");
  if (!labelsPath || !existsSync(labelsPath)) throw new Error("--report needs --labels <labels.json>");
  const results = (JSON.parse(await readFile(outPath, "utf8")) as CaseResult[]).filter((r) => r.ok);
  const labels = JSON.parse(await readFile(labelsPath, "utf8")) as Record<string, boolean>;
  const hits = results.flatMap((r) => r.hits.map((h) => ({ ...h, prompt: r.id, relevant: labels[h.id] === true })));
  const unlabelled = hits.filter((h) => !(h.id in labels)).length;
  const relevant = hits.filter((h) => h.relevant).length;
  console.log(`prompts: ${results.length}; candidate hits: ${hits.length}; relevant: ${relevant}; unlabelled: ${unlabelled}`);

  const injected = (floor: number, maxHits: number, keep: (h: (typeof hits)[number]) => boolean = () => true) =>
    results.flatMap((r) => hits.filter((h) => h.prompt === r.id && h.score >= floor && keep(h)).slice(0, maxHits));
  const baseline = injected(FLOORS[0]!, HOOK_MAX_HITS).reduce((n, h) => n + h.tokens, 0);

  const row = (label: string, set: typeof hits) => {
    const tp = set.filter((h) => h.relevant).length;
    const tokens = set.reduce((n, h) => n + h.tokens, 0);
    const prompts = new Set(set.map((h) => h.prompt)).size;
    const p = set.length ? (tp / set.length).toFixed(2) : "  - ";
    const rc = relevant ? (tp / relevant).toFixed(2) : "  - ";
    console.log(`${label.padEnd(26)} injected ${String(set.length).padStart(3)}  relevant ${String(tp).padStart(3)}  precision ${p}  recall ${rc}  noise ${String(set.length - tp).padStart(3)}  prompts ${String(prompts).padStart(2)}  tokens ${String(tokens).padStart(5)} (saves ${baseline - tokens} vs floor ${FLOORS[0]})`);
  };

  console.log(`\nfloor sweep (maxHits ${HOOK_MAX_HITS}, current floor ${HOOK_MIN_SCORE}):`);
  for (const f of FLOORS) row(`floor ${f.toFixed(2)}`, injected(f, HOOK_MAX_HITS));
  console.log("\nmaxHits at the current floor and at 0.70:");
  for (const m of [1, 2, 3, 5]) {
    row(`floor ${HOOK_MIN_SCORE} maxHits ${m}`, injected(HOOK_MIN_SCORE, m));
    row(`floor 0.70 maxHits ${m}`, injected(0.7, m));
  }
  console.log("\nfloor sweep without tests/ hits (a per-source rule):");
  for (const f of FLOORS) row(`floor ${f.toFixed(2)} no tests`, injected(f, HOOK_MAX_HITS, (h) => kind(h.source) !== "tests"));
  console.log("\nprecision by source kind and score band:");
  for (const k of ["code", "tests", "docs", "odd"]) {
    const bands = FLOORS.map((f, i) => {
      const band = hits.filter((h) => kind(h.source) === k && h.score >= f && h.score < (FLOORS[i + 1] ?? 1.01));
      return `${f.toFixed(2)}:${band.filter((h) => h.relevant).length}/${band.length}`;
    });
    console.log(`${k.padEnd(6)} ${bands.join("  ")}`);
  }
}

await (process.argv.includes("--report") ? report() : collect());
