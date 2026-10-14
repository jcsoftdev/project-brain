import { applySlim, defaultPaths, measure, revertSlim, type SlimPaths } from "../context/slim.js";
import type { MemorySection } from "../context/claude-md.js";

const LABEL: Record<MemorySection["kind"], string> = {
  "project-brain": "project-brain",
  foreign: "other tool",
  user: "yours",
};

export interface ContextOptions {
  paths?: SlimPaths;
  log?: (line: string) => void;
}

export function parseSlimArgs(args: string[]): { apply: string[]; revert: boolean; description?: string } {
  const out = { apply: [] as string[], revert: false, description: undefined as string | undefined };
  let i = 0;
  while (i < args.length) {
    const a = args[i++]!;
    if (a === "--revert") out.revert = true;
    else if (a === "--apply") {
      while (i < args.length && !args[i]!.startsWith("--")) out.apply.push(args[i++]!);
    } else if (a === "--description") out.description = args[i++];
  }
  return out;
}

export async function execute(args: string[], opts: ContextOptions = {}): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const [sub, ...rest] = args;
  if (sub !== "slim") {
    log("Usage: project-brain context slim [--apply <section-id>... [--description <text>]] [--revert]");
    return 1;
  }
  const paths = opts.paths ?? defaultPaths();
  const flags = parseSlimArgs(rest);

  if (flags.revert) {
    const r = await revertSlim(paths);
    if (!r.restored) {
      log("Nothing to revert: no slim backup found.");
      return 1;
    }
    log(`Restored ${r.restored}`);
    for (const s of r.removedSkills) log(`Removed skill ${s}`);
    if (r.safetyCopy) log(`Your edits since the slim were kept at ${r.safetyCopy}`);
    return 0;
  }

  if (flags.apply.length > 0) {
    const r = await applySlim(paths, { ids: flags.apply, description: flags.description });
    for (const m of r.moved) log(`Moved ${m.id} (~${m.tokens} tokens) to skill ${m.skill}`);
    for (const x of r.refused) log(`Refused ${x.id}: ${x.reason}`);
    if (r.backup) log(`Backup: ${r.backup} (undo with: project-brain context slim --revert)`);
    return r.refused.length > 0 && r.moved.length === 0 ? 1 : 0;
  }

  let sections: MemorySection[];
  try {
    sections = await measure(paths);
  } catch {
    log(`No readable CLAUDE.md in ${paths.claudeDir}`);
    return 1;
  }
  const total = sections.reduce((n, s) => n + s.tokens, 0);
  log("Token counts are estimates (characters / 4), not a tokenizer.\n");
  for (const s of [...sections].sort((a, b) => b.tokens - a.tokens)) {
    log(`${String(s.tokens).padStart(7)}  ${LABEL[s.kind].padEnd(13)} ${s.id}`);
  }
  log(`${String(total).padStart(7)}  total`);
  log("\nOnly sections marked 'yours' can be moved: project-brain context slim --apply <section-id>...");
  return 0;
}
