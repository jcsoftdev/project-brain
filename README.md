# project-brain

Local-first MCP server that gives AI tools semantic memory of your codebase.

project-brain indexes your project files into a local LanceDB vector store using Ollama embeddings, and builds a SQLite **structural graph** (symbols + call edges) with a WASM tree-sitter parser. Once indexed, AI assistants connected via MCP can search your codebase **semantically** (by meaning) AND **structurally** (exact symbols, callers/callees, change blast-radius), track module documentation, and maintain knowledge that persists across sessions.

## Quick Start

Three commands, roughly two minutes:

```bash
brew install jcsoftdev/tap/project-brain   # 1. install (see below for other channels)
project-brain setup                        # 2. register in your AI tools — once per machine
cd my-project && project-brain init        # 3. index this project
```

That is the whole setup. The rest of this section explains what each step did and how to confirm it worked.

### 1. Install

Pick **one**. All three deliver the same self-contained binary — no Node, no Bun, nothing else at runtime:

```bash
brew install jcsoftdev/tap/project-brain                                                            # Homebrew
curl -fsSL https://raw.githubusercontent.com/jcsoftdev/project-brain/main/scripts/install.sh | sh   # no package manager
bun install -g project-brain                                                                        # or npm / pnpm / yarn
```

Confirm it landed:

```bash
project-brain --version
```

See [Install](#install) for platform coverage and how upgrades work per channel.

### 2. Register in your AI tools

```bash
project-brain setup
```

Detects and registers project-brain with Claude, Codex, Cursor, Gemini, Windsurf, Zed and VS Code, and installs the `brain-audit` and `brain-okf` host skills. Run it **once per machine**, not per project. Skip the skills with `--no-skills`.

### 3. Index a project

```bash
cd my-project
project-brain init
```

Detects the stack, writes a `CLAUDE.md` with MCP instructions, installs a `git commit` hook, scaffolds module stubs, and runs the first index.

No Ollama running? Use `project-brain init --no-embed`. Everything structural still works — see [What you get without Ollama](#what-you-get-without-ollama).

### 4. Check it worked

```bash
project-brain health
```

Reports embedding service, index counts and staleness. If chunks are `0` or semantic results come back empty, this is the command that tells you why.

### 5. Use it

From the terminal:

```bash
project-brain map                      # what matters in this codebase, ranked
project-brain impact parseConfig       # what breaks if I change this
project-brain callers runSync          # who depends on this
```

Or just ask your AI assistant in plain language — it picks the tool itself:

> "What breaks if I change `parseConfig`?"
> "How does authentication work here?"

See [Recipes](#recipes--get-the-most-out-of-it) for the prompts that steer it best.

### What runs automatically after `init`

| Trigger | What happens |
|---|---|
| `git commit` | git hook runs `project-brain sync` — keeps the index fresh |
| File save (while server is running) | File watcher detects the change and re-indexes it |
| AI tool connects | MCP server starts on stdio, tools are ready |

### What you get without Ollama

Ollama powers **semantic** search only. Everything else works offline with no model at all:

| Works with no Ollama | Needs Ollama |
|---|---|
| `find`, `callers`, `callees`, `impact`, `trace`, `map` (structural graph) | `search_context` at full quality |
| `code` (keyword/BM25 search) | |
| `search_context`, degraded to a keyword floor and flagged `mode: "lexical"` | |

### Optional — capture the *why*

The index knows what the code does; it cannot know why it is that way. A knowledge bundle holds that half:

```bash
project-brain okf init
```

See [`okf`](#okf--knowledge-bundles-the-why-not-the-what).

## Prerequisites

| | Needed for | Notes |
|---|---|---|
| *nothing* | running project-brain | Every channel ships a self-contained prebuilt binary with the runtime, WASM grammars and templates bundled in. No Bun, no Node — the `curl` installer does not even need one to *install* it. |
| [Ollama](https://ollama.com) | semantic search only | `init` auto-pulls `qwen3-embedding:0.6b` (1024-dim, fast, code-capable), falling back to `nomic-embed-text` if it cannot. Pre-pull with `ollama pull qwen3-embedding:0.6b`. Everything structural works without it. |
| [Bun](https://bun.sh) ≥ 1.3.14 | building from source only | Not needed for any install channel. |

## Install

Every channel ships the same artifact: a `bun build --compile` binary with the
runtime, WASM grammars and templates embedded. Nothing else is needed at runtime.

| Channel | Command | Platforms | Upgrade with |
|---|---|---|---|
| **Homebrew** | `brew install jcsoftdev/tap/project-brain` | macOS (Apple Silicon), Linux | `brew upgrade project-brain` |
| **curl** | see [below](#curl-no-package-manager) | macOS (Apple Silicon), Linux x64/arm64 | re-run the installer |
| **Registry** | `bun install -g project-brain` (or npm / pnpm / yarn) | all, including Intel macOS and Windows | `project-brain update` |
| **Scoop** | `scoop install project-brain` — *bucket not published yet* | Windows | `scoop update project-brain` |

**Intel macOS**: no prebuilt binary. Homebrew and curl both refuse rather than
hand you an arm64 binary — use a registry install there.

`project-brain update` reads the binary's own path to work out which channel
installed it and prints the matching command. For a channel it cannot drive it
says so rather than guessing: a guessed `npm install -g` would leave a second
copy shadowing the first.

### curl (no package manager)

```bash
curl -fsSL https://raw.githubusercontent.com/jcsoftdev/project-brain/main/scripts/install.sh | sh
```

| Variable | Default | Purpose |
|---|---|---|
| `BRAIN_INSTALL_DIR` | `~/.local/bin` | Where the binary lands |
| `BRAIN_VERSION` | latest release | Pin a tag, e.g. `v0.17.0` |

The script verifies the downloaded binary actually runs on your machine before
moving it onto your PATH, so a wrong-arch or truncated download fails at install
time instead of at first use.

### Build it yourself

```bash
git clone git@github.com:jcsoftdev/project-brain.git   # or https://github.com/jcsoftdev/project-brain.git
cd project-brain
bun build ./src/cli.ts ./src/parser/worker.ts --compile --outfile project-brain
./project-brain --version
```

`worker.ts` is a required second entrypoint — without it the parser's worker pool cannot resolve its own imports inside the compiled binary and silently extracts zero symbols.

### Keeping the host skills current

Skills live in your assistant's global skills directory, not in the package, so upgrading the binary does not move them. project-brain compares the installed skill content against what the running binary carries and refreshes any directory it originally created — whichever way you upgraded. It never creates one (that is `setup`'s job) and never touches a directory it cannot prove it wrote. Opt out with `BRAIN_NO_SKILL_REFRESH=1`.

## Usage modes

project-brain runs in two modes — CLI and inside AI tools. Both call the same underlying commands.

### CLI (terminal)

Run commands directly from your terminal in any project directory.

### Inside AI tools (slash commands)

Once `project-brain setup` has registered the MCP server in your AI tool, you can invoke commands as slash commands from within Claude Code, Codex, Cursor, Windsurf, Zed, VS Code, or any MCP-compatible AI:

| Slash command | Equivalent CLI | What it does |
|---|---|---|
| `/brain-setup` | `project-brain setup` | One-time global registration in AI tools |
| `/brain-init` | `project-brain init` | Initialize current project + index + git hook |
| `/brain-sync` | `project-brain sync` | Incremental sync of changed files |
| `/brain-reindex` | `project-brain reindex` | Drop and rebuild full index |
| `/brain-health` | `project-brain health` | Diagnose Ollama, index staleness, git hook |

These five are thin wrappers over the CLI. **project-brain does not install them** — write them yourself as skills in your assistant's global skills directory if you want the shortcuts, or just run the CLI.

### Host skills setup installs

| Skill | Equivalent CLI | What it does |
|---|---|---|
| `/brain-audit` | *(none — host skill)* | Whole-project audit: dead code, orphan UI, broken flows, coverage gaps, plus findings by severity across security, performance and architecture |
| `/brain-okf` | *(none — host skill)* | Write an OKF concept: the reasoning behind code, anchored to a verified symbol and checkable by `okf audit` |

Unlike the `/brain-*` commands above, these have no CLI equivalent. They are **host skills**: the logic lives in `SKILL.md` and runs inside the assistant, which calls project-brain's MCP tools to do the work. That is what lets `brain-audit` answer "is this export dead?" with `find_callers` instead of guessing from a grep, and what lets `brain-okf` verify an anchor with `find_symbol` before writing it.

`project-brain setup` installs them into each registered tool's global skills directory (`~/.claude/skills/`, `~/.codex/skills/`, or the shared `~/.agents/skills/`). Opt out with `project-brain setup --no-skills` (`--no-brain-audit` still works as an alias).

**Both are offered, not scheduled.** Nothing invokes them for you and nothing fires on commit — you decide when. `brain-audit` runs discovery, proposes an audit module set, and waits for you to confirm before loading anything: 34 modules exist, and loading all of them every time is what makes an audit expensive. `brain-okf` proposes the type, title, and anchor and waits before creating a file, because whether an insight deserves a permanent home is your call, not the assistant's.

Setup never overwrites a skill directory it did not create. Ownership is proven per directory, so your own hand-written `brain-okf/` is left untouched — and reported — while `brain-audit/` upgrades beside it.

## MCP Tools

Once connected over MCP, AI assistants get these tools. The server also injects routing instructions so the assistant picks the right one (semantic vs structural).

### Semantic (meaning-based)

| Tool | What it does |
|---|---|
| `search_context` | Semantic/conceptual lookup. Returns ranked snippets, each with a `chunk_id`. **Primary** for fuzzy/cross-file questions ("how does X work"). |
| `expand_context` | Full body of a `chunk_id` from `search_context` — read this instead of re-reading whole files. |

### Lexical (keyword — no embeddings needed)

| Tool | CLI | What it does |
|---|---|---|
| `search_code` | `project-brain code "<query>" [--limit N]` | Exact/keyword full-text search (BM25) over indexed code — identifiers, error strings, exact phrases. Works offline without Ollama. Not regex. |

### Structural (AST graph — exact, no embeddings needed)

Every structural tool is also a native CLI command — reusable without an MCP client, and even more offline than the MCP path (no Ollama probe, reads the local `graph.db` directly):

| Tool | CLI | What it does |
|---|---|---|
| `find_symbol` | `project-brain find <name>` | Exact symbol definition(s) by name: path, line range, kind, signature. Use when you know the name. |
| `find_callers` | `project-brain callers <name>` | Every symbol that calls the named symbol (who depends on X). |
| `find_callees` | `project-brain callees <name>` | Every symbol the named symbol calls (what X depends on). |
| `impact` | `project-brain impact <name> [--max-depth N]` | Blast radius — all symbols transitively affected if the named symbol changes (reverse call graph, bounded by `maxDepth`, default 6, max 20). |
| `trace_path` | `project-brain trace <from> <to> [--max-depth N]` | Shortest call path between two symbols (how does A reach B) — ordered caller→callee chain (default depth 8, max 20). |
| `repo_map` | `project-brain map [--budget N] [--focus a,b,c]` | Token-budgeted overview of the most important symbols in the codebase, ranked by PageRank over the call graph. Use for repo orientation / where to start reading. |

The CLI commands exit 0 for any executed query — including legitimate empty results (symbol not found, no callers, no path within depth). They exit 1 only for usage errors or an unindexed/unsynced project (`project-brain init`/`sync` first).

### Modules & knowledge

| Tool | What it does |
|---|---|
| `list_modules` | Browse the indexed structure by module. |
| `get_module` | Retrieve all chunks for a module. |
| `add_knowledge` | Persist a note/decision into the brain for future sessions. |
| `delete_knowledge` | Remove chunks by source (deleted/renamed files). |
| `check_health` | Embedding service + index status; run if results look empty or stale. |
| `list_projects` | List every indexed project with chunk counts and embedding meta. |
| `delete_project` | Delete an entire indexed project's vector index + metadata (never touches its `.project-brain/` directory). |
| `manage_adr` | Create or list Architecture Decision Records. Append-only: supersede by creating a new ADR with `supersedes:<slug>`. |
| `get_architecture` | One-call project summary: detected tech stack, indexed modules, chunk count, and symbol count. |
| `sync_project` | Re-index changed files now (incremental, hash-gated). Streams progress via MCP notifications when the client supplies a `progressToken`. Use when results look stale. |

Curated knowledge (the *why* behind the code) lives in an OKF bundle rather than in these tools — see [`okf`](#okf--knowledge-bundles-the-why-not-the-what).

Routing: exact symbol → `find_symbol`; who-calls → `find_callers`; what-it-calls → `find_callees`; "what breaks if I change X" → `impact`; "how does A end up calling B" → `trace_path`; fuzzy/conceptual → `search_context` then `expand_context`; exact string/identifier you can type verbatim → `search_code`. The canonical tool list lives in `src/constants.ts` (`TOOL_CATALOG`) and is rendered into both the MCP server instructions and the per-project `CLAUDE.md`.

## Recipes — get the most out of it

You talk to your **AI assistant** in natural language; it picks the right tool. These prompts steer it well:

| Goal | Ask your assistant | Tool it uses |
|---|---|---|
| **Refactor safely** | "What breaks if I change `parseConfig`?" | `impact` — see the full blast radius before you touch it |
| **Understand unfamiliar code** | "How does authentication work here?" | `search_context` → `expand_context` |
| **Find a definition fast** | "Where is `GraphStore` defined?" | `find_symbol` (exact, faster than grep) |
| **Trace dependencies** | "Who calls `chargeCard`?" / "What does `runSync` call?" | `find_callers` / `find_callees` |
| **Onboard to a module** | "Summarize the `store` module" | `list_modules` → `get_module` |
| **Persist a decision** | "Remember that we use RRF for hybrid search" | `add_knowledge` (survives across sessions) |

Tips to maximize value:

- **Structural and lexical tools work without Ollama.** `find_symbol` / `find_callers` / `find_callees` / `impact` / `trace_path` query the local SQLite graph, and `search_code` queries the local FTS index — all work even with embeddings unavailable. `search_context` itself degrades gracefully too: with no Ollama it falls back to a BM25 lexical floor (code-aware query expansion over the local FTS index) and marks the result `degraded: true, mode: "lexical"` instead of failing — conceptual recall is reduced, so start Ollama for full semantic search when you can.
- **Keep the index fresh automatically.** The git hook re-syncs on commit and the file watcher re-indexes on save while `serve` runs — no manual step. Run `project-brain sync` after big external changes.
- **Prefer `expand_context` over re-reading files.** `search_context` returns a `chunk_id`; expanding it is cheaper than the assistant reading the whole file.
- **Lead with the exact name when you have it.** "find_symbol X" / "who calls X" is faster and more precise than a semantic search.
- **Big repos stay cheap.** The walk honors `.gitignore`; generated/minified files (>512 KB or pathological lines) are skipped from structural parsing automatically.

## Commands

### `setup`

One-time global setup. Detects your environment and registers project-brain with AI tools (Claude, Cursor, Gemini, Codex, Windsurf, Zed, VS Code).

```bash
project-brain setup
```

#### Model routing for sub-agents

Setup also writes model-routing guidance into each detected host's rules file: which **tier** — `fast`, `balanced`, or `deep` — a delegated sub-agent should run at for a given kind of task, and how to set that tier *on that host*.

Tiers rather than model names, because four of the six supported hosts default sub-agents to inheriting the parent's model and set the model in an agent-definition file rather than at the call — so "pass the `model` param" is true on Claude Code and false almost everywhere else. Each host gets its own text:

| Host | Where the model is chosen |
| --- | --- |
| Claude Code | per spawn — `model` on the Agent/Task call |
| Codex | `~/.codex/agents/*.toml`; per-spawn needs `[features.multi_agent_v2]` |
| Gemini CLI | `~/.gemini/agents/*.md` frontmatter `model:` |
| Cursor | sub-agent definition: `fast`, `inherit`, or a pinned id |
| opencode | `opencode.json` → `agent.<name>.model` (`provider/model-id`) |
| Windsurf | Devin Local routes tiers on its own |

It is opt-**out**: a non-interactive run installs it, and `--no-model-routing` is the way out. `--model-routing` forces it without prompting. The section carries a content version, so a later release updates it in place instead of leaving you on the text you first accepted.

Override the table in `~/.project-brain/model-routing.json`:

```json
{
  "models": { "claude": { "deep": "opus" } },
  "rules": [{ "task": "Write a migration", "tier": "deep", "why": "irreversible" }]
}
```

`models` remaps tiers per host, one tier at a time. `rules` adds a task, or retiers a built-in one by matching its `task` exactly. A malformed file warns and falls back to the defaults — it never fails setup.

**Hooks (Claude Code only).** Accepting the guidance also installs a `SessionStart` hook that injects the tier table once per session. Claude Code is the only host verified to fire `PreToolUse` on a sub-agent spawn and to accept `additionalContext` on `SessionStart`; a hook that silently never fires is worse than none.

Add `--routing-hook-strict` for enforcement: a `PreToolUse` hook that blocks a spawn naming no model and tells the model to re-issue it with one. Off by default — inheriting the session model is sometimes the right call, and the guard fails open on any payload it cannot parse. `--no-routing-hook` skips both.

### `init`

Initialize a project. Detects the stack, writes a `CLAUDE.md` with MCP instructions, installs a git hook, scaffolds module stubs in `docs/modules/`, and indexes the project.

```bash
project-brain init [--skip-index] [--no-embed] [--embed-model=<key>]
```

- `--skip-index` — skip the initial index pass (useful when Ollama is not yet running)
- `--no-embed` — index for keyword search only, no embedding model (equivalent to `BRAIN_EMBED_MODEL=none`)
- `--embed-model=<key>` — pin the embedding model non-interactively (registry key or raw Ollama model name)

When run in a terminal (and neither flag nor `BRAIN_EMBED_MODEL` is set), `init` interactively asks which embedding model to use — including the option to skip embeddings entirely for a lexical-only project. Non-interactive runs (CI, scripts, non-TTY) skip the prompt and fall back to the registry default.

### `sync`

Incremental sync — re-indexes files that changed since the last sync.

```bash
project-brain sync
```

### `reindex`

Full re-index — drops and rebuilds the entire vector index for the current project.

```bash
project-brain reindex [--no-embed] [--embed-model=<key>]
```

Same `--no-embed`/`--embed-model=<key>` flags as `init` (see above). Since a full rebuild is already a deliberate action, `reindex` also interactively asks which model to use when run in a terminal without a flag/env override — defaulting to whatever model the project is currently indexed with.

### `health`

Check system health: Ollama availability, LanceDB status, and staleness of the index.

```bash
project-brain health
```

### `search`

Search the indexed context and print compact results. Primarily used internally: `init` installs a `UserPromptSubmit` hook (`project-brain search --stdin`) in `.claude/settings.json` that auto-injects relevant context on every prompt, so retrieval is deterministic rather than relying on the AI to call a tool.

```bash
project-brain search "how does auth work"
echo "how does auth work" | project-brain search --stdin
```

### Structural & lexical commands (`find`, `callers`, `callees`, `impact`, `trace`, `map`, `code`)

Native CLI equivalents of the structural/lexical MCP tools — see the [Structural](#structural-ast-graph--exact-no-embeddings-needed) and [Lexical](#lexical-keyword--no-embeddings-needed) tables above for the full CLI ↔ MCP tool mapping. All read the local index directly (no Ollama probe), so they work fully offline once `project-brain sync` has run.

```bash
project-brain find GraphStore
project-brain callers runSync
project-brain callees runSync
project-brain impact parseConfig --max-depth 3
project-brain trace handleSearch runSync
project-brain map --budget 2000 --focus createServer,runSync
project-brain code "chargeCard" --limit 5
```

### `okf` — knowledge bundles (the *why*, not the *what*)

The index answers "what does this code do". It cannot answer "why is it like this", because that never existed in the AST. An **[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) v0.2 bundle** — a committed directory of Markdown files with YAML frontmatter — holds that half, and `okf` keeps the two halves honest about each other.

```bash
project-brain okf init [dir]               # scaffold an empty bundle. Never overwrites.
project-brain okf validate [dir]           # conformance (SPEC §11). Offline.
project-brain okf sync [dir]               # index the concepts so search returns them
project-brain okf audit [dir]              # cross-check the bundle against the code graph
project-brain okf audit --symbol <name>    # which concepts to re-read after <name> changes
```

`init` writes `index.md` and `log.md` and stops — **no seeded concepts**, because a bundle shipped with examples makes the first `audit` report coverage gaps across the whole repo. Type directories appear when the first concept needs them.

It also re-renders `CLAUDE.md`. `project-brain init` runs before any bundle exists, so the knowledge-bundle section is omitted then; `okf init` adds it once there is something to point at. That section asks the assistant to **decide, at the end of a task, whether anything belongs in the bundle** — and says plainly that most tasks produce nothing. A checkpoint that feels obliged to produce a file is a concept mill, and noise in a knowledge bundle is worse than gaps. Projects with no bundle never see the instruction.

`dir` defaults to `./okf`. Because the bundle is tracked in git, a plain `project-brain sync` also keeps it fresh — bundle files are routed through the curated projection instead of being chunked as raw markdown, so `search_context` returns the reasoning next to the code it explains.

A concept anchors code through `resource` (and `sources[]`), resolved from the bundle root:

```yaml
---
type: Gotcha
title: Language.load ignores Bun's /$bunfs virtual filesystem
resource: ../src/parser/wasm.ts#loadGrammar   # or ../src/parser/wasm.ts#L14-L24
generated: { by: "human:you", at: 2026-07-30T00:00:00-05:00 }
---
```

`audit` reports four things no single graph can answer:

| Finding | Meaning |
|---|---|
| **Broken anchor** | The cited file or symbol is gone — the explanation points at nothing. |
| **Stale concept** | The cited code changed after the knowledge was last confirmed. Uses git commit dates (not mtimes, which every clone resets) against the later of the declared attestation and the concept file's own commit date. |
| **Coverage gap** | Highest-PageRank symbols no concept explains — a documentation backlog in priority order. Test helpers excluded. |
| **Link suggestion** | Two concepts whose code calls across them, but whose prose never does. |

Broken anchors and stale concepts exit 1, so `audit` works as a CI gate. Coverage gaps and link suggestions are backlog and never fail the run. Clear a stale finding by re-reading the concept and adding a `verified` entry — the file changes, so its commit date moves and the finding clears.

### `update`

Update project-brain to the latest published version, using whichever install manager (bun, pnpm, yarn, or npm) it was originally installed with.

```bash
project-brain update
```

Every other command already prints an `update available` notice (current → latest, with the exact command to run) once a day when a newer version is published — `update` runs that command for you instead of requiring a copy-paste.

### `serve`

Start the MCP server. Default mode uses stdio (for local AI tool connections).

```bash
project-brain serve
```

#### `serve --http`

Start the MCP server over Streamable HTTP with bearer-token authentication. Useful for remote access or multi-client setups.

```bash
BRAIN_HTTP_TOKEN=your-secret project-brain serve --http [--port 3000]
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BRAIN_HTTP_PORT` | `3000` | Port for HTTP server mode |
| `BRAIN_HTTP_TOKEN` | — | **Required** for `serve --http`. Bearer secret. |
| `BRAIN_DATA_DIR` | `~/.project-brain/data` | LanceDB + structural graph data directory |
| `BRAIN_EMBED_MODEL` | `qwen3-embedding:0.6b` | Ollama embedding model (registry keys: `qwen3-embedding`, `nomic-text`; or any raw Ollama model name; `none` disables embeddings — lexical/keyword search only, no Ollama needed) |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server URL |
| `BRAIN_NO_UPDATE_CHECK` | — | Set to `1` to disable the update-available notice |

## Tuning (environment variables)

`sync`/`reindex` throughput and resilience are tunable independently of the model:

| Variable | Default | Range | Effect |
|---|---|---|---|
| `BRAIN_EMBED_BATCH_SIZE` | `64` | `1`–`512` | Texts per Ollama embed request. Lower it if Ollama times out under load. |
| `BRAIN_EMBED_CONCURRENCY` | `1` | `1`–`16` | Concurrent embed requests. Defaults to `1` — a single local Ollama instance is GPU-compute-bound, so concurrency>1 adds no throughput, only false-timeout risk. Raise it only against a genuine multi-host pool (`BRAIN_OLLAMA_HOSTS`) or remote inference API where separate hardware actually runs requests in parallel. |
| `BRAIN_OLLAMA_HOSTS` | — | comma-separated URLs | Pool of Ollama hosts for round-robin embedding (e.g. `http://127.0.0.1:11434,http://127.0.0.1:11435`). Falls through to the next host on failure; only `null`s when every host fails. |
| `BRAIN_EMBED_MODEL` | `qwen3-embedding:0.6b` | model name | Override the embedding model (see table above). |
| `BRAIN_SYNC_WINDOW_FILES` | `200` | `1`+ | Files held in memory at once during a sync. Their content, chunks and vectors are live together and released when the window is stored, so peak memory tracks this number rather than repository size. Lower it on a memory-constrained host; raising it buys nothing once a window already fills an embed batch. |

A partial or total embed failure makes `sync`/`reindex` exit non-zero (`1`) — check the exit code in automation (CI, git hooks), not just stderr text.

Leaving `BRAIN_EMBED_BATCH_SIZE`/`BRAIN_EMBED_CONCURRENCY` unset does not mean "always use the defaults above" — each unset knob is auto-detected from machine resources at sync time (available free memory, and whether another model is already loaded in Ollama alongside the embed model, which risks VRAM contention). A log line like `[sync] auto-tuned embed config: concurrency=1 batchSize=16 (vram-contention)` explains why. Set either var explicitly to pin it — env values always win over auto-detection.

`.project-brain/manifest.db` (plus its `-wal`/`-shm` sidecars) replaces the old `hashes.json` incremental-sync manifest. It is gitignored already — if you have a stale `hashes.json` around, it migrates automatically on first sync and is renamed to `hashes.json.bak`.

## Update notifications

The CLI checks (at most once a day, in the background) whether a newer `project-brain` is published on npm and prints a one-line notice when one is available. It is fail-silent, adds zero latency (the check runs in a detached process; the current command reads only a cached result), and is skipped in CI. Disable it with `BRAIN_NO_UPDATE_CHECK=1`. Run `project-brain update` to apply it.

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `Ingested: 0` or empty semantic results | Ollama not running or model not pulled. Start Ollama and `ollama pull qwen3-embedding:0.6b`, then `project-brain reindex`. Run `project-brain health` to confirm. (Structural tools still work without Ollama.) |
| Structural tools (`find_symbol`/`impact`) return nothing | The graph isn't populated yet — run `project-brain sync` (or `reindex`) once. Structural extraction does **not** need Ollama, so this works even offline. |
| Results feel stale | `project-brain reindex` rebuilds from scratch; `project-brain sync` picks up changed files. |
| Changed `BRAIN_EMBED_MODEL` and search broke | A new model usually means a new vector dimension. Run `project-brain reindex` — the table re-embeds and migrates the dimension. |
| `serve --http` returns `401 unauthorized` | Set `BRAIN_HTTP_TOKEN` and send `Authorization: Bearer <token>`. |
| `unsupported platform` on launch | No prebuilt binary for your `os-arch`. Build the standalone binary from source (see Install). |
| Want to see what's wrong | `project-brain health` reports Ollama status, index counts, and staleness. |

## Module Documentation Workflow

When you run `project-brain init`, it detects top-level source directories and creates stub files in `docs/modules/<name>.md`. These stubs are indexed immediately so semantic search works even before they are filled.

To populate a stub:
1. Open a project session with your AI assistant.
2. The AI reads `CLAUDE.md` and finds the `## Module Documentation` section.
3. The AI fills each stub (Purpose, Key Files, Dependencies, Data Flow, Gotchas, Last Updated).
4. The AI calls `add_knowledge` with the filled content so it is vectorized into project-brain.

Run `project-brain sync` after filling stubs to ensure they are re-indexed with their full content.

## Author

[jcsoftdev](https://github.com/jcsoftdev)
