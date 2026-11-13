/**
 * How long sub-agent hand-backs are, and what the ~400-word report contract would have saved.
 * Reads Claude Code transcripts READ-ONLY (`~/.claude/projects/*\/*.jsonl`, sidechains excluded)
 * and prints counts only; no transcript text leaves this process.
 *
 *   bun scripts/measure-agent-reports.ts [--days 30] [--cap 400]
 *
 * A hand-back reaches the parent in one of three shapes, and the same report can appear in more
 * than one (a queued copy and the delivered message), so each is keyed by agent id plus text:
 *   - a synchronous Agent/Task tool result (`toolUseResult.status: "completed"`);
 *   - a SubagentHandback, framed as `<agent-message from="…">[Subagent hand-back] … The report follows:`;
 *   - a background agent's `<task-notification>` whose `<result>` carries the text.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const DAYS = arg("--days", 30);
const CAP = arg("--cap", 400);
const since = Date.now() - DAYS * 24 * 60 * 60_000;
const root = join(homedir(), ".claude", "projects");

const POINTER = /report was delivered to you as a message from/;
const HANDBACK = /<agent-message from="([^"]+)">\n\[Subagent hand-back\][^\n]*The report follows:\n([\s\S]*?)<\/agent-message>/g;
const NOTIFICATION = /<task-notification>[\s\S]*?<task-id>([^<]+)<\/task-id>[\s\S]*?<summary>Agent "[\s\S]*?<result>([\s\S]*?)<\/result>/g;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const dedent = (text: string) => text.replace(/^ {2}/gm, "");

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out);
}

function reportsOf(line: Record<string, any>): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const result = line.toolUseResult;
  if (result?.status === "completed" && typeof result.agentId === "string") {
    const text =
      typeof result.handbackReport === "string"
        ? result.handbackReport
        : (Array.isArray(result.content) ? result.content : []).map((c: any) => c?.text ?? "").join("\n");
    if (text.trim() !== "" && !POINTER.test(text)) found.push([result.agentId, text]);
  }
  const strings: string[] = [];
  collectStrings(line.message?.content ?? line.content ?? line.attachment ?? null, strings);
  for (const s of strings) {
    for (const m of s.matchAll(HANDBACK)) found.push([m[1]!, dedent(m[2]!)]);
    for (const m of s.matchAll(NOTIFICATION)) if (!POINTER.test(m[2]!) && m[2]!.trim() !== "") found.push([m[1]!, m[2]!]);
  }
  return found;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

const seen = new Set<string>();
const counts: number[] = [];
const sessions = new Set<string>();
let compactions = 0;

for (const project of await readdir(root).catch(() => [])) {
  const dir = join(root, project);
  for (const file of await readdir(dir).catch(() => [])) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(dir, file);
    if ((await stat(path)).mtimeMs < since) continue;
    for (const raw of (await readFile(path, "utf8")).split("\n")) {
      if (raw === "") continue;
      let line: Record<string, any>;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      const at = Date.parse(line.timestamp ?? "");
      if (!(at >= since)) continue;
      if (line.type === "system" && line.subtype === "compact_boundary") compactions++;
      for (const [agentId, text] of reportsOf(line)) {
        const key = `${agentId}\u0000${Bun.hash(text.trim())}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sessions.add(file);
        counts.push(words(text));
      }
    }
  }
}

counts.sort((a, b) => a - b);
const total = counts.reduce((s, n) => s + n, 0);
const over = counts.filter((n) => n > CAP);
const saved = over.reduce((s, n) => s + (n - CAP), 0);
const capped = counts.map((n) => Math.min(n, CAP));

console.log(`window: last ${DAYS} days, cap ${CAP} words`);
console.log(`hand-backs: ${counts.length} across ${sessions.size} sessions; compactions in window: ${compactions}`);
console.log(`words per hand-back: median ${percentile(counts, 50)}, p90 ${percentile(counts, 90)}, max ${counts.at(-1) ?? 0}, mean ${counts.length ? Math.round(total / counts.length) : 0}`);
console.log(`over the cap: ${over.length} (${counts.length ? Math.round((100 * over.length) / counts.length) : 0}%)`);
console.log(`words saved if capped: ${saved} of ${total} (${total ? Math.round((100 * saved) / total) : 0}%), ~${Math.round(saved * 1.3)} tokens`);
console.log(`after the cap: median ${percentile([...capped].sort((a, b) => a - b), 50)}, p90 ${percentile([...capped].sort((a, b) => a - b), 90)}`);
