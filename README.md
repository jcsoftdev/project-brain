# project-brain

Local-first MCP server that gives AI tools semantic memory of your codebase.

project-brain indexes your project files into a local LanceDB vector store using Ollama embeddings, and builds a SQLite **structural graph** (symbols + call edges) with a WASM tree-sitter parser. Once indexed, AI assistants connected via MCP can search your codebase **semantically** (by meaning) AND **structurally** (exact symbols, callers/callees, change blast-radius), track module documentation, and maintain knowledge that persists across sessions.

## Quick Start

```bash
# 1. Install globally
bun install -g project-brain

# 2. One-time: register in your AI tools (Claude, Codex, Cursor, Gemini, Windsurf, Zed, VS Code)
project-brain setup

# 3. Per-project: initialize, index, and install git hook
cd my-project
project-brain init
```

After `init`, the following run **automatically** without any extra steps:

| Trigger | What happens |
|---|---|
| `git commit` | git hook runs `project-brain sync` — keeps the index fresh |
| File save (while server is running) | File watcher detects the change and re-indexes it |
| AI tool connects | MCP server starts on stdio, tools are ready |

## Prerequisites

- **Nothing extra to run it.** The registry install ships a self-contained, prebuilt binary per platform (the runtime is bundled in) — you do **not** need Bun or Node installed to use project-brain.
- **Bun** ≥ 1.3.14 — only needed to build/run **from source** ([install](https://bun.sh)).
- **Ollama** (optional, only for semantic search) — download from [ollama.com](https://ollama.com). `project-brain init` **auto-pulls** the default embedding model `qwen3-embedding:0.6b` (1024-dim, fast, code-capable). To pre-pull it: `ollama pull qwen3-embedding:0.6b`. If it can't be pulled, project-brain falls back to `nomic-embed-text`. The structural tools work with **no** Ollama at all.

## Install

### Registry (recommended)

```bash
bun install -g project-brain
# or
npm install -g project-brain
```

### Standalone binary (no runtime required)

```bash
git clone https://github.com/jcsoftdev/project-brain
cd project-brain
bun build ./src/cli.ts --compile --outfile project-brain
./project-brain --help
```

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

The slash commands are Claude Code skills installed globally at `~/.claude/skills/brain-*/SKILL.md`. They work in any session regardless of the current project.

## MCP Tools

Once connected over MCP, AI assistants get these tools. The server also injects routing instructions so the assistant picks the right one (semantic vs structural).

### Semantic (meaning-based)

| Tool | What it does |
|---|---|
| `search_context` | Semantic/conceptual lookup. Returns ranked snippets, each with a `chunk_id`. **Primary** for fuzzy/cross-file questions ("how does X work"). |
| `expand_context` | Full body of a `chunk_id` from `search_context` — read this instead of re-reading whole files. |

### Lexical (keyword — no embeddings needed)

| Tool | What it does |
|---|---|
| `search_code` | Exact/keyword full-text search (BM25) over indexed code — identifiers, error strings, exact phrases. Works offline without Ollama. Not regex. |

### Structural (AST graph — exact, no embeddings needed)

| Tool | What it does |
|---|---|
| `find_symbol` | Exact symbol definition(s) by name: path, line range, kind, signature. Use when you know the name. |
| `find_callers` | Every symbol that calls the named symbol (who depends on X). |
| `find_callees` | Every symbol the named symbol calls (what X depends on). |
| `impact` | Blast radius — all symbols transitively affected if the named symbol changes (reverse call graph, bounded by `maxDepth`). |
| `trace_path` | Shortest call path between two symbols (how does A reach B) — ordered caller→callee chain. |
| `repo_map` | Token-budgeted overview of the most important symbols in the codebase, ranked by PageRank over the call graph. Use for repo orientation / where to start reading. |

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
