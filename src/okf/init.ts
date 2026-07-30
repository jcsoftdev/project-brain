import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

/** Bundle directory name, relative to the project root, when none is given. */
export const DEFAULT_BUNDLE_DIRNAME = "okf";

export interface OkfInitOptions {
  /** Project root. The bundle lands at <root>/okf unless `dir` overrides it. */
  root: string;
  /** Absolute path to the bundle directory. Defaults to <root>/okf. */
  dir?: string;
  /**
   * Re-render the project rules once the bundle exists.
   *
   * `project-brain init` writes CLAUDE.md before any bundle is present, so the
   * conditional knowledge-bundle section is absent at that point. Without this
   * refresh the host would never be told the bundle exists. Injected so the
   * scaffolding stays testable without the whole init machinery.
   */
  refreshRules?: () => Promise<void>;
}

export interface OkfInitResult {
  /** Filenames written, relative to the bundle directory. */
  created: string[];
  /** Filenames left alone because they already existed. */
  skipped: string[];
}

/**
 * §8 allows the ROOT index exactly one frontmatter key — the version the bundle
 * targets. Any other key there is a conformance issue, so this stays minimal.
 */
const INDEX_MD = `---
okf_version: "0.2"
---

# Knowledge

Curated knowledge for this repository, in [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) v0.2.

This bundle holds what the code cannot say about itself: why a thing is built the
way it is, which constraints must keep holding, and the traps that already cost
someone a debugging session. It deliberately does **not** describe what the code
*is* — symbols, call graphs and line ranges are answered by \`find_symbol\`,
\`find_callers\` and \`impact\`, faster and never stale.

## Concept types

| Type | Answers | Lives in |
|------|---------|----------|
| \`Decision\` | why this way, and what the rejected alternative cost | \`decisions/\` |
| \`Gotcha\` | the trap, and how it was found | \`gotchas/\` |
| \`Constraint\` | what must hold, and what breaks if it does not | \`constraints/\` |

The type vocabulary is this bundle's convention — \`validate\` requires a non-empty
\`type\`, not a specific one. Add a type when you need one.

## Anchoring

Every concept cites code through \`resource\` (and \`sources[]\`), resolved from this
directory:

\`\`\`yaml
resource: ../src/parser/wasm.ts#loadGrammar   # or ../src/parser/wasm.ts#L14-L24
\`\`\`

An unanchored concept is invisible to \`okf audit\` — no broken-anchor check, no
staleness check. Prefer a symbol anchor: a line range breaks when the file shrinks.

## Keeping it honest

\`\`\`bash
project-brain okf validate   # conformance, offline
project-brain okf sync       # index the concepts so search returns them
project-brain okf audit      # cross-check against the code graph
\`\`\`

\`audit\` exits 1 on broken anchors and stale concepts, so it works as a CI gate.
Coverage gaps and link suggestions are backlog and never fail the run — and they
rank by structural centrality, not by explanatory need, so treat them as a hint
about areas rather than a list of files to write.
`;

const LOG_MD = `# Knowledge Update Log

Newest first. One bullet per concept created, revised, or retired, with a line on
what changed and why — enough that someone can follow the bundle's history without
reading every diff.
`;

/**
 * Scaffold an empty OKF bundle.
 *
 * Deliberately seeds NO concepts. A bundle shipped with examples would make the
 * first `audit` report coverage gaps across the whole repo — noise before anyone
 * has written a single real thing. Type directories are created by the first
 * concept that needs them, not up front.
 *
 * Never overwrites: an existing file is reported as skipped, so re-running is
 * safe on a bundle someone has already been curating by hand.
 */
export async function runOkfInit(options: OkfInitOptions): Promise<OkfInitResult> {
  const dir = options.dir ?? join(options.root, DEFAULT_BUNDLE_DIRNAME);
  await mkdir(dir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  for (const [name, content] of [
    ["index.md", INDEX_MD],
    ["log.md", LOG_MD],
  ] as const) {
    const dest = join(dir, name);
    if (existsSync(dest)) {
      skipped.push(name);
      continue;
    }
    await writeFile(dest, content, "utf8");
    created.push(name);
  }

  // Best-effort: a bundle that exists but whose rules were not refreshed is
  // still a working bundle. Failing here must not report a half-made one.
  if (options.refreshRules) {
    try {
      await options.refreshRules();
    } catch (e: any) {
      console.warn(`Warning: bundle created, but refreshing project rules failed: ${e.message}`);
    }
  }

  return { created, skipped };
}
