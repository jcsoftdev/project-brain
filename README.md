# project-brain

Local-first MCP server that gives AI tools semantic memory of your codebase.

The whole Claude Code flow on one page (every piece, how to turn it off, what leaves the machine, troubleshooting): [docs/flow-map.md](docs/flow-map.md).

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

Detects and registers project-brain with Claude, Codex, Cursor, Gemini, Windsurf, Zed and VS Code, and installs its host skills. Run it **once per machine**, not per project. Skip the skills with `--no-skills`.

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

Skills live in your assistant's global skills directory, not in the package, so upgrading the binary does not move them. project-brain compares the installed skill content against what the running binary carries and refreshes any directory it originally created — whichever way you upgraded. It never creates one (that is `setup`'s job) and never touches a directory it cannot prove it wrote. Opt out with `BRAIN_NO_SKILL_REFRESH=1`. A checkout run from source (`bun src/cli.ts`, in a worktree or not) never refreshes skills, repairs host configs or adds hooks, so a branch cannot push unreleased content into your sessions; set `BRAIN_FORCE_SKILL_REFRESH=1` to allow those writes anyway.

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
| `/brain-design-review` | *(none — host skill)* | Audit a rendered UI like a designer (ten categories, AI-slop check), score it, then fix findings one commit each and re-verify |
| `/brain-qa-only` | *(none — host skill)* | Explore a browser, API, CLI or worker surface and report reproducible bugs with evidence; never edits product code |
| `/brain-ux-review` | *(none — host skill)* | Walk 3-5 real user tasks across a whole app, one feature or one screen; diagnose information architecture, interaction, layout and accessibility with labelled evidence; redesign the flows and write a validation plan (audit, redesign or implement mode) |
| `/brain-commit` | *(none — host skill)* | Write a commit message in the convention the repository's own log already shows |
| `/brain-record` | *(none — host skill)* | Record the flow a branch touches as video evidence for a PR or ticket |
| `/brain-worktree` | *(none — host skill)* | Give an isolated worktree its own index (seeded from the main checkout) and its own leased port |
| `brain-style` | *(none — host skill)* | Keep written code declarative: a comment only where it says something the code cannot |

Unlike the `/brain-*` commands above, these have no CLI equivalent. They are **host skills**: the logic lives in `SKILL.md` and runs inside the assistant, which calls project-brain's MCP tools to do the work. That is what lets `brain-audit` answer "is this export dead?" with `find_callers` instead of guessing from a grep, and what lets `brain-okf` verify an anchor with `find_symbol` before writing it.

`brain-style` is the one that carries no command. It is a standing rule about written code rather than a task to invoke, and it claims precedence over the comment density an agent would otherwise copy from the files around it — leave it unticked at setup if your codebase wants that density kept.

`project-brain setup` installs them into each registered tool's global skills directory (`~/.claude/skills/`, `~/.codex/skills/`, or the shared `~/.agents/skills/`). Opt out with `project-brain setup --no-skills` (`--no-brain-audit` still works as an alias).

**They are offered, not scheduled.** Nothing invokes them for you and nothing fires on commit — you decide when. `brain-audit` runs discovery, proposes an audit module set, and waits for you to confirm before loading anything: 51 modules exist, and loading all of them every time is what makes an audit expensive. `brain-okf` proposes the type, title, and anchor and waits before creating a file, because whether an insight deserves a permanent home is your call, not the assistant's.

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
| `okf_candidates` | Mines `fix:` commits for OKF write candidates: scores each against the symbol graph and existing bundle coverage, so the agent gets ranked suggestions instead of hunting through history by hand. |
| `okf_write` | Writes a new OKF concept file from structured fields (type, title, anchor, body). Refuses to write when any declared anchor (`resource` or `sources[]`) doesn't resolve against the repo and its symbol graph — an unverifiable claim never reaches the bundle. |

Curated knowledge (the *why* behind the code) lives in an OKF bundle rather than in these tools — see [`okf`](#okf--knowledge-bundles-the-why-not-the-what).

Routing: exact symbol → `find_symbol`; who-calls → `find_callers`; what-it-calls → `find_callees`; "what breaks if I change X" → `impact`; "how does A end up calling B" → `trace_path`; fuzzy/conceptual → `search_context` then `expand_context`; exact string/identifier you can type verbatim → `search_code`. The canonical tool list lives in `src/constants.ts` (`TOOL_CATALOG`) and is rendered into the MCP server instructions plus the global rules files for hosts not proven to surface those instructions to the model. Claude Code IS proven to surface them (they land in context on every MCP connection), so its global and per-project `CLAUDE.md` point at that live copy instead of re-embedding the catalog.

## Reranking (optional)

`search_context` can rerank its retrieved pool with [TypeSafe](https://typesafe.ai)'s Jev model before the usual threshold/MMR/budget steps run, scoring every candidate's relevance to the query with a single call. Measured on a bench of 332 mined queries (30 candidates each): recall@1 goes from 66.0% to 84.3%, and MRR from 0.761 to 0.894, at p50 0.60s and $0.15 for the whole bench.

It is opt-in and sends data off-machine: **the query text and every candidate's code/doc snippet are sent to `api.typesafe.ai`.** Enable it only if that is acceptable for your codebase.

To enable it:

- Run `project-brain setup` and select the reranker unit when prompted (you'll be asked for a token), or
- Pass `--reranker-token <token>` to `project-brain setup` for a non-interactive install, or
- Set the `TYPESAFE_API_KEY` environment variable (checked before the file either way).

With the reranker unit installed, a Claude Code `SessionStart` hook (`project-brain jev-env`) also exports the stored token as `TYPESAFE_API_KEY` into the session's shell, so the typesafe-ai skill, the TypeSafe SDK and ad-hoc scripts find it too. It appends to `CLAUDE_ENV_FILE`, leaves an already-set `TYPESAFE_API_KEY` alone, and never prints the token. Re-run `project-brain setup` once to add the hook to an existing install; the stored token is reused.

With no token configured, nothing changes — zero network calls, identical result order. Any failure (timeout, non-2xx, a malformed response) falls back silently to the normal, unreranked order rather than surfacing an error. `project-brain health` reports `reranker: configured` once a token resolves.

### Skill suggestions

Suggestions come from their own **global** `UserPromptSubmit` hook, `project-brain suggest --stdin`, separate from the per-project retrieval hook. `setup` installs it by default (unit `hooks:suggest`), and an existing install gets it added **once** the next time its routing `SessionStart` hook runs, without rerunning `setup`. It works in every project, including ones never initialized with project-brain: no index is opened, and the prompt vector comes from the project's indexed embedding model when there is one, otherwise from the default model (keyword matching when Ollama does not answer). Without a token it stays silent. To opt out, deselect "Skill/tool suggestions" in `setup` (or remove the hook by hand) and it is never re-added, or set `BRAIN_SKILL_PICKER=0` / `BRAIN_TOOL_PICKER=0`.

With a token configured, the hook asks Jev, for each shortlisted skill, whether the work your prompt asks for needs it: process skills (planning, brainstorming, debugging, review) and domain skills (the framework or tool the work touches) can both apply to one prompt, so every skill Jev judges at least 70% likely is suggested, best first, one line each: `Suggested skill: <name> — <its full description>`. The description is the skill's own, whole, because with the [compact skill listing](#claude-tui) the model may only have the name. Below 70% nothing is added. A ceiling of 10 picks per prompt (`pickCeiling` in `~/.project-brain/skills.json`, or `BRAIN_SKILL_PICK_MAX`) guards against a runaway response; when more skills clear the floor, the top ones are kept and a line on stderr says how many were cut. General-use skills (see the [compact skill listing](#claude-tui)) are never asked about or suggested. A suggestion still visible in the live conversation is not repeated. Skills are read from `~/.claude/skills`, `<project>/.claude/skills`, `~/.agents/skills` and installed plugins (`plugin:skill`), cached on disk (rebuilt when any SKILL.md changes, or after ten minutes), plus the built-in and connector skills Claude Code lists without a SKILL.md, whose descriptions the [compact skill listing](#claude-tui) mod records in `~/.project-brain/skill-listing.json`. The shortlist is the 12 skills nearest the prompt by embedding similarity (the project's embedding model, so prompts in any language match English descriptions; keyword overlap without embeddings, or when nothing ranks), plus up to 16 process skills, those whose description opens with "Use when", "Use before" or "You MUST use": a task prompt names the work, not the process, so embeddings rank those far down ("construye una feature nueva de login" put superpowers:brainstorming 58th of 135). There is no similarity floor for skills; Jev's 70% judgment is the filter. When Jev keeps failing (three requests in a row), the hook records it in `~/.project-brain/skill-pick-health.json` and the listing mod keeps descriptions until a request succeeds again.

**The prompt text and the shortlisted skills' names and descriptions (at most 28) are sent to `api.typesafe.ai`** — the same disclosure as the reranker. Trivial prompts send nothing. The whole hook gives up after 5s (Jev itself after 1s) and fails silently. Opt out with `BRAIN_SKILL_PICKER=0`.

**Tool suggestions.** The same request can also carry a second question about your MCP tools, and the hook then adds `Suggested tool: mcp__<server>__<tool> — <why>` (again only at 70% confidence). Claude Code defers most MCP tools, so the assistant often never reaches for the right one; the hint names it. project-brain keeps its own catalog in `~/.project-brain/`: `tool-catalog.json` for user-scope servers (`~/.claude.json` top level, `~/.claude/mcp-servers.json`) and a per-project file for local-scope servers plus the project's `.mcp.json` ones, which are used only if you approved them in Claude Code (so a freshly cloned repo can never make project-brain start its servers): each stdio server, or unauthenticated HTTP server, is started briefly and asked for `tools/list` (10s per server, four at a time; a failure or a 401 skips that server, and project-brain itself is left out). Servers that cannot be listed this way, such as claude.ai connectors, are filled in by name only from the `deferred_tools_delta` entries in your recent Claude Code transcripts (claude.ai connectors and plugin servers only). The suggest hook never builds the catalog: it only reads it, and when it is missing, older than 24 hours or its servers changed, it spawns `project-brain tool-catalog refresh` in the background (at most once every ten minutes). Run that command yourself to rebuild on demand; it prints how many tools it found, and it also embeds the tools in the background so the hook only ever reads cached vectors. Both questions share the one Jev request, so tool suggestions add no round trip, and the same disclosure applies to the shortlisted tools' names and descriptions (at most 12). Opt out with `BRAIN_TOOL_PICKER=0`, independently of `BRAIN_SKILL_PICKER`.

**Task-switch notice.** Once the session's context is at least 30% full (read from the latest assistant `usage` in the transcript, against the auto-compact window or 200K), the same Jev request (only when the skill or tool picker is on; with both opted out nothing is sent at all) also asks whether the prompt starts a task unrelated to the recent work. What leaves the machine for that question, only above 30%: your last four prompts (300 characters each), the last assistant text block cut to 400 characters, and the names (never the inputs or outputs) of the last few tools used. Jev answers `new_task`, `related_task` or `same_task`. A confident `new_task` (0.8 by default) shows a one-line notice (hook `systemMessage`) suggesting `/clear` and resending; a `related_task` answer of 0.6 or more suggests `/compact focus on: <the first ~60 characters of your prompt>`; a continuation at 75% or more suggests `/compact`. `/clear` is never suggested while work is in flight, meaning a background agent, shell command or workflow that has not reported back, or a tool call without its result; past 75% it becomes `/compact`, otherwise nothing. The notice appears at most once per session for each of `/clear` and `/compact`. The prompt always goes through, and under 30% nothing extra is asked or sent. Opt out with `PROJECT_BRAIN_TASK_SWITCH=0`; tune with `PROJECT_BRAIN_TASK_SWITCH_PCT`, `PROJECT_BRAIN_COMPACT_PCT`, `PROJECT_BRAIN_TASK_SWITCH_CONFIDENCE` (0.5-1, default 0.8) and `PROJECT_BRAIN_CONTEXT_WINDOW`. `scripts/calibrate-task-switch.ts` replays your own transcripts read-only against Jev (at most 30 requests) to measure the `/clear` precision and recall at 0.7, 0.8 and 0.9.

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

#### Context-economy units

Every context-economy feature is its own unit in the `setup` checklist, ticked by default, and an upgrade that never saw them turns them on without a prompt. Untick one to switch it off; your choice is stored in `~/.project-brain/features.json`, which the hooks read at runtime (the existing `PROJECT_BRAIN_*=0` variables still override it).

| Unit | What it does | Leaves the machine |
|---|---|---|
| `feature:routing-skill` | model-routing table loads as the `brain-model-routing` skill; unticked, the full block goes back inline | nothing |
| `feature:task-switch` | one-line `/clear` or `/compact` notice at 30% context | your last few prompts, to api.typesafe.ai, with a TypeSafe token and a picker on |
| `feature:search-gate` | per-prompt search skips non-code prompts, caps hits, floors reranker scores | nothing extra |
| `config:mcp-prune` | disables MCP servers a project never uses | nothing |
| `config:mcp-prune-jev` | opt-in: lets prune ask Jev about registered projects with little history | each unused server's name and tool names, the project's stack and unscoped dependency names, to api.typesafe.ai, with a TypeSafe token |
| `config:context-slim` | moves large user sections of CLAUDE.md into skills | nothing |
| `tui:context-gate` | leaves out hook-injected context the prompt does not need | your prompt and the injected text it judges (head and tail of each piece), to api.typesafe.ai, with a TypeSafe token |
| git post-commit hook (written by `init`, not a setup unit) | runs `sync --changed-only && conceptualize` in the background after every commit | the commit message, each touched module's full diff (up to 5 modules per commit) and that module's current concept doc, to the backend `config:concept-provider` chose: **anthropic** (default) sends them to the Anthropic API, only when Anthropic credentials resolve (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ant auth login`); **claude-code** sends them to Anthropic through your Claude Code login (`claude -p`, haiku, your subscription quota, no API key); **ollama** sends nothing — `qwen3.5:4b` on the local Ollama writes the doc. A missing backend skips the commit's modules with one line in `.project-brain/sync.log`. Turn it off with the `feature:conceptualize` setup unit, or `PROJECT_BRAIN_CONCEPTUALIZE=0` |
| `config:concept-provider` | which backend writes the module docs, saved in `~/.project-brain/concept.json`; asked once, changed with `setup --concept-provider anthropic\|ollama\|claude-code` | see the post-commit row: anthropic and claude-code reach Anthropic, ollama stays local |

`setup` asks which parts to install — one checklist per group (Hosts, Guidance,
Skills, Claude TUI, Other), asked in order, so each question is about one kind of thing — and
remembers the answer in `~/.project-brain/setup-selection.json`. Re-running it
shows what is currently on disk beside what you are selecting, then a diff of
what will change before anything is written. A part you deselect is removed and
stays removed; a part that ships in a later release shows up marked `NEW` and
unchecked. On a first run nothing is pre-ticked except what is already on disk,
so pressing Enter through the checklist changes nothing — you install what you
tick.

Without a TTY it never prompts — it applies the saved selection, or each part's
default if there is none.

```bash
project-brain setup --with=skill:brain-audit,hooks:worktree
project-brain setup --without=skill:brain-record
project-brain setup --all
project-brain setup --none
```

Run `project-brain setup --with=nope` to print the list of valid ids.

After an upgrade, a prompt in a Claude Code session lists the units that shipped since you last chose (in neither list of `setup-selection.json`) and are not on disk: up to five by name, then a count. The list is computed between sessions, by `update` and by the SessionEnd maintenance job, so a prompt never waits on it; it is shown by one session only, each unit is named at most once per machine, a unit you declined is never named, and `PROJECT_BRAIN_WHATS_NEW=0` turns it off. `project-brain setup --new` opens the checklist with only those units and leaves every other answer as it is. Without a prompt, `--new --with=<ids>` enables what it names and `--new --without=<ids>` declines what it names, leaving the rest undecided; `--new --yes` enables only the units that are on by default unconditionally, so neither an opt-in unit nor one that turns on when a TypeSafe token exists is enabled that way. `--all`, `--none` and the `--no-*` flags are refused with `--new`. `project-brain status` keeps listing every unit that is available but not enabled.

#### Claude TUI

The "Claude TUI" checklist sets up Claude Code's terminal. Every unit changes files under `~/.claude`, so an upgrade never installs them on its own: they show up marked `NEW` and unchecked. Untick a unit to undo exactly what it wrote.

| Unit | What it changes | Undo (untick) |
|---|---|---|
| `tui:activity-pane` | Writes the `project-brain-activity` mod into a local marketplace at `~/.project-brain/claude-plugins/`, registers it in `~/.claude/settings.json` (`extraKnownMarketplaces["project-brain"]`, `enabledPlugins["project-brain-activity@project-brain"]`) and, on first install, sets `tui` to `"fullscreen"`, remembering the value it replaced; a renderer you pick later is kept on updates | Deletes both entries and the files it wrote, and puts your previous `tui` value back unless you changed it since |
| `tui:readable-replies` | Adds a marked block to `~/.claude/CLAUDE.md`: result first, full sentences, evidence at the end, no narration between tool calls | Deletes the block; the rest of the file stays as it was |
| `tui:terminal-theme` | Adds a marked block at the end of your Ghostty config (Supacode merges the same file): the active theme's colours, background opacity 0.88 and blur 20, and `background-opacity-cells` so tabs, pills and diff rows are as translucent as the rest. Off by default | Deletes only the block; the rest of the file stays as it was |
| `tui:claude-theme` | Writes a Claude Code custom theme to `~/.claude/themes/project-brain-<theme>.json` and sets `theme` to it, so the chat, the prompt and the `/diff` view use the same palette as the terminal and the activity pane. Off by default | Deletes the file and puts your previous `theme` back |
| `tui:skill-listing` | Writes the `project-brain-skill-listing` mod into the same local marketplace and registers it (`enabledPlugins["project-brain-skill-listing@project-brain"]`); asks for your general-use skills and saves them to `~/.project-brain/skills.json`; writes `~/.project-brain/skill-usage.json`. Unchecked even on a first run: it trades skill descriptions for tokens, which is yours to decide | Deletes its plugin entry, its files and `skill-usage.json`; the marketplace entry goes only with the last mod in it. `skills.json` stays, since the suggest hook reads it too |
| `tui:context-gate` | Writes the `project-brain-context-gate` mod into the same local marketplace and registers it (`enabledPlugins["project-brain-context-gate@project-brain"]`). Unchecked even on a first run: it leaves context out of what the model reads, which is yours to decide | Deletes its plugin entry and its files; the marketplace entry goes only with the last mod in it |

The activity pane is a side pane named "Actividad" with tabs for todos, commands and uncommitted changes; each changed file expands to its diff against HEAD, with line numbers, and Enter on a file name opens it in one reused nvim split (Supacode, tmux, or a Terminal window) with its diff. When subagents run, a selector shows each one with its own summary, commands and diff; the header and footer stay fixed while the body scrolls. It docks on the right only in the fullscreen renderer (`/tui fullscreen`), which is why the unit switches it on. `/activity` reopens the pane after you close it, and ctrl+o still expands tool rows in the chat. The cost it shows is Claude Code's own estimate for the session, not a bill. If another marketplace is already registered under the name `project-brain`, setup reports the unit as foreign and leaves it alone; other plugins' settings are never touched. Mods need Claude Code 2.1.287 or later, and do not load when `disableAllHooks` is set.

**Compact skill listing.** Claude Code sends the model a listing of every installed skill, one line with its description each, at the start of every session and every subagent: about 7,500 tokens for 136 skills. The `project-brain-skill-listing` mod rewrites that listing so every name stays but most descriptions go, in one of two modes:

- **With the Jev picker** (a well-formed TypeSafe token, the picker on, the suggest hook installed and hooks not disabled, and fewer than three Jev failures in a row): every skill is listed by name only, except your general-use skills. The suggest hook then brings in, per prompt, the full description of each skill the work needs (see [Skill suggestions](#skill-suggestions)). Delegations get the same treatment: whenever a subagent, teammate or workflow agent is spawned, the mod runs `project-brain suggest --agent --stdin` on the task's description and prompt (one Jev request, same floor and ceiling) and puts the picked skills, with their full descriptions, before the subagent's prompt. With no token, a Jev failure or past the 5 s budget, the prompt goes out unchanged. A subagent's listing is names-only only when its spawn carried such a block; any other subagent gets the usage mode below.
- **Without it**: your general-use skills, the `brain-*` skills, the 15 you invoked most in the last 30 days and any you used in the last 7 keep their description; the rest are names. With fewer than 10 recorded invocations, the listing is left as it is.

Usage numbers come from `project-brain skill-usage --write`, which counts Skill tool calls and slash commands in `~/.claude/projects/**/*.jsonl` (under `CLAUDE_CONFIG_DIR` when set) from the last 30 days (newest first, at most 8 GiB read, a call copied into a resumed session counted once) and writes `~/.project-brain/skill-usage.json`. Setup runs it on install; the mod reruns it at session start when the file is a day old. `project-brain skill-usage` alone prints the counts and writes nothing. The mod only rewrites the listing Claude Code itself wrote, and on any failure passes the text through unchanged.

General-use skills keep their full line in every mode and are never suggested by Jev, so nothing is said twice. Setup asks for them each time it installs or updates the unit, as a multiselect of your installed skills with the most used marked as suggestions (never pre-ticked); the default is none. You can also edit the file by hand; every key is optional:

```json
{
  "general": ["brain-style", "superpowers:brainstorming"],
  "picker": true,
  "pickCeiling": 10,
  "keepTop": 15,
  "keepRecentDays": 7
}
```

`picker: false` (or `BRAIN_SKILL_PICKER=0`) turns off the per-prompt and per-delegation skill picks, and the listing falls back to the usage mode. `keepTop` and `keepRecentDays` only matter in that mode.

**Context gate.** Other hooks and plugins inject context into every session: a SessionStart hook's handbook, a UserPromptSubmit hook's notes, a PostToolUse hook's policy. The `project-brain-context-gate` mod asks Jev, before that text reaches the model, whether the prompt at hand needs it, and leaves out what it does not.

**Your prompt and the injected text the gate judges are sent to `api.typesafe.ai`.** Each piece is sent as its first 800 and last 400 characters.

Only additional context and plain hook output from SessionStart, UserPromptSubmit and PostToolUse hooks, or a plugin's context, is judged. A blocking error, a stopped continuation, a permission decision, a system message and anything from a PreToolUse guard always reach the model as they are. Several hooks' outputs arrive joined line by line in one attachment, so the mod judges each run of lines between allowlisted ones. project-brain's own hooks wrap their text in `<!-- project-brain:begin -->` and `<!-- project-brain:end -->`, and everything between them is kept whole. Engram, project-brain and any signature you add under `contextAllow` in `~/.project-brain/skills.json` are never filtered, and pieces under 300 characters are not worth a request. One `project-brain suggest --context --stdin` call per attachment asks about every piece at once, and a piece Jev scores at 0.5 or above stays.

With no token, `"contextGate": false`, `BRAIN_CONTEXT_GATE=0`, a timeout or any error, the text goes out unchanged. After three Jev failures in a row (`~/.project-brain/context-gate-health.json`) the gate stops asking, and tries again once 10 minutes have passed since the last failure. Each piece left out is listed in `~/.project-brain/context-gate-log.json`.

The gate keeps the prompt cache. Claude Code asks for an attachment once per process, and again on resume, so every answer is stored per session and replayed byte for byte. A resumed session never asks Jev about its history, and sends any history it holds no answer for unchanged until a turn it started itself completes. Answers survive compactions: a row a compaction preserved replays the answer it was given before. The trade-off is that a verdict is pinned to its text for the whole session: a hook that injects the same text every turn is judged once, against the first prompt that saw it, and only text the gate has not seen before is judged after a compaction. Turning the gate off or uninstalling it mid-session costs one cache rewrite on the next resume, because the history goes back to the text the gate had left out. In a measured six-turn session with a resume, every request read the previous one's prefix from cache, and the gate cut the prompt from 104k to 75k tokens.

#### Worktree lifecycle

```bash
project-brain worktree create <name> [--base <ref>]   # .claude/worktrees/<name>, branch worktree/<name>, own brain
project-brain worktree finish [<name|path>] [--yes]   # dry run unless --yes
project-brain worktree sweep [--yes] [--branches]     # finish every worktree that qualifies
```

`create` also clones the main checkout's `node_modules` into the worktree copy-on-write (`cp -c -R` on macOS/APFS, `cp --reflink=always` on Linux), so a worktree costs ~0 extra disk instead of a second install. In a monorepo it clones every workspace package's `node_modules` too (the packages listed in `package.json` `workspaces` or `pnpm-workspace.yaml`), each only where that package exists in the worktree and has no `node_modules` yet. When the lockfile content hash matches the main checkout's, the clone is all it does. When it differs, it clones anyway and then runs the package manager's install in the worktree (`bun install`, `pnpm install`, `npm install` or `yarn install`, picked from the lockfile); because the clone is copy-on-write, the install only writes the packages that changed. That install runs the package manager's lifecycle scripts (such as `postinstall`) from the worktree's `package.json`. It has a 10-minute timeout. If it fails, times out, or the tool is missing, every clone is removed, along with any `node_modules` the install created where there was none before, so the worktree has no `node_modules` again, and `create` prints one line saying why. The Node version and platform are not compared: a clone reproduces the main checkout's folder exactly, so it works in the worktree exactly as well as it works in the main checkout. The clone is independent, so changing a dependency in the worktree never touches the main checkout. On macOS it first checks that the main checkout and the worktree are on the same APFS volume, because `cp -c` silently falls back to a full copy elsewhere (HFS+, exFAT, or across volumes). If the filesystem cannot clone, nothing is copied and `create` prints one line saying why.

A worktree is finished when it is not the main checkout, its branch is merged into the default branch (or has no commits of its own and is over an hour old), its tree is clean (a lone untracked `node_modules` symlink is tolerated), and no process is using it. `--yes` removes the directory with `git worktree remove` and the branch with `git branch -d`; it never forces and never uses `-D`, so unmerged or dirty work is never removed. `sweep` removes only worktrees under `.claude/worktrees`; it lists ones outside it as `[outside .claude]` and removes them only with `--include-outside` (or `finish <path> --yes`, since naming a worktree is explicit consent). It also lists merged branches that have no worktree (`--branches` deletes those). `create` adds `.claude/worktrees/` and the files `init` generates (`.project-brain/`, `CLAUDE.md`, `docs/modules/`, `.claude/settings.json`) to the repository's local `info/exclude`, so a fresh worktree is not dirty.

`setup` adds a default-on `SessionEnd` hook (`hooks:worktree-sweep`) that runs `worktree sweep --yes --quiet` and prints a line only when it removed something. Untick it in `setup`, or use `--without=hooks:worktree-sweep`, to opt out.

#### Disk maintenance

LanceDB keeps every superseded version and soft-deleted row until something removes them, so a busy index can grow to several times its live size (one went from 1.16 GB to 0.16 GB when compacted). `setup` adds a default-on `SessionEnd` hook (`hooks:index-maintenance`) that runs `project-brain maintain --quiet --background`: it returns at once and a detached process does the work, so it never delays the host. That run drops dead worktree indexes (as `worktree prune` does), then compacts the largest idle indexes, and prints `project-brain: reclaimed X GB from N index(es)` only when it freed something. Untick it in `setup`, or use `--without=hooks:index-maintenance`, to opt out.

An index is compacted only when all of these hold: it is at least 256 MB, it was not compacted in the last 24 h, nothing was committed to it in the last 10 minutes, no process has a file open inside it (`lsof`; an unreadable check counts as in use), and it is not the current project's. A run compacts at most 2 indexes, largest first, and stops starting new ones after 60 s. Versions younger than 30 minutes survive. Tune with `BRAIN_AUTO_COMPACT_MIN_MB`, `BRAIN_AUTO_COMPACT_INTERVAL_HOURS`, `BRAIN_AUTO_COMPACT_QUIET_MINUTES`, `BRAIN_AUTO_COMPACT_MAX_TABLES`, `BRAIN_AUTO_COMPACT_BUDGET_SECONDS` and `BRAIN_AUTO_COMPACT_RETENTION_MINUTES`.

`project-brain compact [--project <id>]` still reclaims one index on demand. It now refuses, and exits 1, while another process has the index open or the check cannot be made; `--force` overrides that. `compact --help` prints usage and changes nothing.

#### Worktrees start from the main checkout's index

`init` inside a linked git worktree copies the main checkout's vectors, manifest and graph before indexing, then syncs only what differs. Every path those artefacts store is repository-relative, so one checkout's index describes another equally well, and sync re-hashes each file anyway — a stale or wrong-branch base costs a few extra embeddings, never a wrong index.

On this repository that took a worktree's first index from 2m38s to 2.1s.

It copies nothing, and indexes normally, when the main checkout has no index, when the worktree already has one, or when the two would disagree about the embedding model. Vectors from a different model are not comparable, and that is the one case sync could not correct on its own.

#### Memory slimming

Everything in `~/.claude/CLAUDE.md` loads on every turn of every session. `setup` already moves project-brain's own long block (the model-routing guidance) into the on-demand `brain-model-routing` skill, leaving a short pointer, and an existing install migrates the next time `setup` or `update` re-applies it. For the rest of the file, the `config:context-slim` unit (on by default) moves your own sections of 1500 tokens or more into skills each time `setup` or `update` runs, and unticking it restores them; managed blocks are never touched, so a file that is all managed blocks changes nothing. The manual command stays available:

```bash
project-brain context slim                       # measure: estimated tokens per section (chars / 4)
project-brain context slim --apply user:my-notes # move your own section into a skill (backup first)
project-brain context slim --revert              # restore the latest backup, remove the skills it made
```

Sections are marked `project-brain`, `other tool` (inside another tool's `<!-- x:start -->`/`<!-- x:end -->` or `<!-- x -->`/`<!-- /x -->` markers) or `yours`. Only `yours` can be moved; content a tool regenerates (for example gentle-ai) is refused, and has to be changed through that tool's own override mechanism. Moved sections become skills named `memory-<heading>` with a description derived from the heading (`--description` overrides it). Backups live in `~/.claude/context-slim/<timestamp>/`; each `--revert` undoes the newest slim that still has a backup, and keeps the pre-revert CLAUDE.md under `~/.claude/context-slim/safety/`.

#### Unused MCP servers

Every enabled MCP server loads its tool list and instructions into every session of every project, used or not. `project-brain mcp prune` reads each project's transcripts (subagents included) and finds the servers that project has not called in 30 days:

```bash
project-brain mcp prune            # this project: what would be disabled, no changes
project-brain mcp prune --all      # every project in ~/.claude.json
project-brain mcp prune --apply    # add them to that project's disabledMcpServers (backup first)
project-brain mcp prune --revert   # re-enable exactly what --apply disabled
```

It is per project: usage in one project never disables a server in another, and nothing touches the user-wide list. Git worktrees of a repo pool their usage and history, so a fresh worktree inherits the repo's. A project needs 10 sessions, or 14 days of history with at least 3 sessions inside the window, and its directory must still exist; new projects are handled by a later setup or update once they have history. Jev assist is opt-in (the `config:mcp-prune-jev` unit, unticked by default and never turned on by an upgrade, or `PROJECT_BRAIN_MCP_PRUNE_JEV=1`; `=0` forces it off) and needs a TypeSafe token. With it on, a project registered with project-brain that has less history, but was used in the window, is not just skipped: on `--apply` (and setup or update), Jev is asked once per repo which of its unused servers it will need, and only those it rates under 20% are disabled. Answers are cached for 30 days per project and server, the whole run stops asking after 15 seconds, and anything unanswered is kept; a dry run and `status` read the cache only. The request carries each unused server's name and tool names, and the project's detected languages, frameworks, package manager and dependency names without scoped `@org/...` ones; never server instructions, the package name, README text, file names, or a server's command, URL or environment. With it on, the prune also runs between sessions without setup: `project-brain init` prunes its own project directory right after registering it, and the SessionEnd maintenance job prunes every registered project. Both leave alone any project where a Claude Code process is running (its working directory is the project or inside it, found with `ps` and `lsof` on macOS or `/proc` on Linux), or whose transcript changed in the last 10 minutes, since a live session there could rewrite `~/.claude.json` and undo the change; when that cannot be told (detection fails, times out after 2s, the platform is unsupported, or the transcript folder cannot be read) the project is skipped too. A later run picks it up. A session already running keeps the servers it started with, and the next one starts without the pruned ones. One prune runs at a time per machine: an automatic one skips when another holds the lock, while `--revert` waits up to 30 seconds and otherwise asks you to retry. The `~/.claude.json` from before the first prune stays in `~/.project-brain/mcp-prune/baseline-claude.json.bak` beside the five newest backups. What can still leak: an unscoped private dependency name, and the names you gave your MCP servers. A server that announced no tools is kept, never judged by its name. project-brain, servers you list in `PROJECT_BRAIN_MCP_PRUNE_KEEP` (comma separated) and servers you switched back on after we disabled them are never touched: re-enabling a pruned server through `/mcp` is respected for good, even if it goes unused afterwards. Only MCP tool calls count as usage, so a server you use through resources or prompts alone belongs on the keep list. Setup (`config:mcp-prune`, checked by default) and `update` run `--apply` for all projects; opt out with `PROJECT_BRAIN_MCP_PRUNE=0`, change the window with `PROJECT_BRAIN_MCP_PRUNE_DAYS`. `~/.claude.json` is backed up under `~/.project-brain/mcp-prune/`, written atomically, and only the disabled lists change. Changes apply from the next session.

#### Auto-compact window

Setup sets Claude Code's `autoCompactWindow` to 400K tokens (`config:auto-compact`, checked by default). Every request re-sends the whole conversation, and those cache reads count against your plan. A 1M-context model left on its default compacts near 967K, so a long session keeps re-reading a far larger context than the work needs. With the cap it compacts near 387K. 200K models aren't affected.

If you already set `autoCompactWindow` to a value of your own, setup reports it as foreign and leaves it alone. To use the full window for one session, start it with `claude --autocompact 1000000`. The setting ranks below that flag, which is why setup doesn't write the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var: the env var outranks the flag and would take the option away.

#### Commit attribution

Claude Code appends `Co-Authored-By` and `Claude-Session: <link>` trailers to the commits and PRs it writes. The harness adds them, not the model, so a rule in a skill can't keep them out. `config:no-commit-attribution` sets `"attribution": {"commit": "", "pr": ""}` in `~/.claude/settings.json`, and that stops them.

It ships **unchecked**: it changes what every commit and PR says in every repo on the machine, and some teams want the trailer. Attribution text you already wrote is reported as foreign and left alone.

#### chrome-devtools autoConnect

The default is **not** your Chrome: the chrome-devtools tools drive a headless browser (see the shared server below). If a detected host runs the [chrome-devtools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp) without `--autoConnect`, setup offers to add it (`config:chrome-autoconnect`) as an explicit opt-in. Without the flag those browser tools launch their own browser; with it they drive the Chrome you are already signed into. Chrome shows an authorization modal on every (re)connection of such a client, by design and with no way to remember the answer ([Chrome for Developers](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)), so expect to approve it each time the server reconnects. The two modes are exclusive: adding `--autoConnect` drops `--headless` and setup's own `--userDataDir` from the same command, and removing it puts them back.

It ships **unchecked**, on purpose. Attaching to your own browser is full control of it, and Chrome says so on the toggle the flag depends on: it "allows external apps to request full control of this browser. This includes read access to your saved data, cookies and site data, and the ability to navigate to any URL."

The flag is only half of it — Chrome refuses the connection until you open `chrome://inspect/#remote-debugging` and turn on "Allow remote debugging for this browser instance" yourself. Setup never flips that toggle; it prints the step after writing the flag. Entries already wired another way (`--browserUrl`, `--wsEndpoint`) or explicitly opted out (`--no-auto-connect`) are left untouched.

It also costs something the config file does not show, so setup prints that too. An attached server holds the CDP connection for its whole life and buffers what the browser reports on it across every tab; nothing releases it early, because your own Chrome outlives the session. Measured on one machine: two servers attached for ~2 days reached 1.6 GB and 742 MB of RSS, and kept growing after Chrome had been closed. And a host runs one MCP server **per session**, so the flag written once buys one attachment per open session — six sessions is six of them. Restarting a session is what frees its attachment.

If that multiplication is the problem rather than the flag itself, the next unit converts it.

#### chrome-devtools shared server

`service:chrome-shared-server` replaces one server per session with one server for every session. It takes the command a detected host already runs, puts it behind an HTTP bridge held open by a login service, and rewrites each host entry to point at `http://127.0.0.1:39100/mcp`. Sessions then cost a client connection each; the machine carries one process and one CDP attachment.

It is **unchecked** by default, and it installs an OS service (launchd on macOS, a systemd user unit on Linux; elsewhere it does not appear) and a Python tool. Both are answers to give on purpose.

The bridge is [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy), installed with `uv` if it is missing. It calls `stdio_client` once at startup and reuses that session for every client, so all clients genuinely share one child, and its JSON-RPC ids cannot collide because it proxies at the MCP semantic layer rather than relaying bytes. Setup pins its SDK below 2: installed without that constraint, the tool resolves an SDK where `request_ctx` no longer exists and every invocation dies at import.

The command moves across **verbatim**, so whatever flags you already answered for — `--autoConnect` included — carry over. The one thing setup adds is the default: a command that chose no browser (no `--autoConnect`, `--browserUrl`, `--wsEndpoint`, `--isolated` or `--userDataDir`) is shared with `--headless --userDataDir=~/.project-brain/chrome-profile`, so every session drives one shared headless browser that the server launches itself on a dedicated, persistent profile: no CDP toggle, no approval modal, and logins that survive restarts. Setup creates that directory (mode 0700) and, while it holds no Chrome profile yet, points you to `project-brain browser login`. That command opens your real Chrome, headed, on the profile with no remote-debugging or automation flags (Google refuses sign-in in automated browsers), and waits until you close it. Chrome allows one process per profile, so if the shared server (or any Chrome) holds the profile it stops and tells you to stop that first; it never kills anything. Restart the shared server afterwards so it reuses the saved login. For a separate session on the same URL (own cookies and storage), the agent passes `isolatedContext` to `new_page` inside that browser instead of starting another one. Removing the unit restores each entry from a record written at install rather than reconstructing a command.

An existing install keeps its command until you change it; setup never rewrites it behind your back. If its service still runs `--autoConnect`, `project-brain setup` prints a one-line notice. To switch it to the headless default, untick "chrome-devtools autoConnect" (or `project-brain setup --without=config:chrome-autoconnect`): setup rewrites the service command and reloads the service itself. To restart it by hand, the command is the one setup prints at install (`launchctl kickstart -k gui/$(id -u)/dev.projectbrain.chrome-devtools-shared` on macOS, `systemctl --user restart dev.projectbrain.chrome-devtools-shared` on Linux). Only the service this unit installed is rewritten; a bridge you set up yourself is never touched.

The `hooks:browser-route` unit (on by default, Claude Code only, opt out by unticking it) adds a `PreToolUse` hook on the `mcp__chrome-devtools__*` tools. The first time a session calls one, it adds one line saying: share the headless browser on its dedicated profile (sign in once with `project-brain browser login`), use `isolatedContext` for a separate session on the same URL, and use your real Chrome only when you ask. It prints nothing otherwise and never blocks the call.

If a host already points at a bridge you set up yourself, under any service name, setup reads that service's command instead. autoConnect then shows `current` when the flag is in that command (`foreign` when it isn't; edit it there), and this unit shows `foreign`: the service is yours, and setup never installs over it or removes it. A service counts only when some host entry's URL uses its `--port`.

##### `project-brain browser`

- `browser status [--json]` is read-only and exits 0 whatever it could not determine. It reports the running server's mode (`headless-profile`, `autoConnect`, or `foreign`, read from its live command line), the profile path and whether Chrome has initialised it (a sign-in itself cannot be proven from disk), the server's and its browser's memory, its age, the open page count through the bridge (`unavailable` when the bridge does not answer), and whether it is over budget.
- **Memory budget.** Past `BRAIN_CHROME_SERVER_MAX_MB` (default 1024) the server is reported as over budget, in `browser status` and in the one-time hook line, together with the restart command of the service this tool installed. Nothing is restarted automatically: every open session holds a persistent connection to the bridge and the bridge exposes no activity time, so there is no reliable idle signal, and a restart on a guess would cut a session's browser. Growth in the headless-profile mode has not been measured; the 1.42 GB figure is from an autoConnect server after about four days.
- `browser prune-pages --older-than <90s|30m|2h|1d> [--yes]` lists, and with `--yes` closes, pages the shared browser has held longer than that. `list_pages` reports no page age, owner or isolatedContext, so "age" is how long this tool has seen the page (recorded between runs; a lower bound), and the selected and newest pages are never listed. It is a dry run without `--yes`, and it refuses on a server that is not the headless-profile one, because there the pages can be your own tabs.

Two limits worth knowing. Sharing the server shares its state: one page list visible to every session, one profile, and process-level flags (`--headless`, `--autoConnect`, `--viewport`, `--blockedUrlPattern`) that can no longer differ per session; `--pageIdRouting`, on by default, is what stops sessions from acting on each other's tabs. And collapsing N attachments to one does not bound how large that one grows — a single attached server was the 1.6 GB measurement — so setup prints the restart command for your platform when it finishes.

#### Ollama interactive lane

One Ollama answers embeds one at a time, so while `sync` sends its 64-chunk batches (about 5.5 s each on an M3 Max), the prompt hook's one-line query waits behind them: measured at 5.4 s p50 against the hook's 800 ms budget. `OLLAMA_NUM_PARALLEL` does not help. A second Ollama that only ever sees queries answers the same query in about 50 ms under that load.

`service:ollama-interactive` runs that second instance as a login service (launchd on macOS, a systemd user unit on Linux; not offered on Windows): `ollama serve` on `127.0.0.1:11435`, with `OLLAMA_KEEP_ALIVE=-1` so the embedding model stays warm, `OLLAMA_MAX_LOADED_MODELS=2` so two projects on different models do not evict each other on every prompt, and `OLLAMA_MODELS` pointing at the default models directory, so nothing is downloaded twice. It also copies the settings that change the numbers a runner produces (`OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE`, `OLLAMA_LLM_LIBRARY`, `OLLAMA_MODELS`) from the default instance's service definition — Homebrew's plist, or the systemd unit together with its `*.service.d/*.conf` drop-ins, with `/usr/share/ollama/.ollama/models` assumed for the official system install — and from setup's own environment when there is no service file (Ollama.app, a hand-started `ollama serve`). Homebrew's Ollama runs with flash attention and a q8_0 KV cache, and an instance without them returns vectors that differ in the third decimal. Setup refuses to install when something else already listens on 11435, and fails (removing what it wrote) when `launchctl bootstrap` or `systemctl --user enable` does not succeed; `inspect` reports the unit stale when the service is written but not loaded. It is **unchecked** by default: it installs an OS service and keeps embedding models resident in memory for good.

The lane is on only where setup installed it (it records `{"interactiveHost": "http://127.0.0.1:11435"}` in `~/.project-brain/ollama.json` and removes it on uninstall) or `BRAIN_OLLAMA_INTERACTIVE_HOST` names a host. Prompt-time single-query embeds — the `suggest` and `search --stdin` hooks (skill, tool and context picks) and the MCP `search_context` query — then go to it. Every multi-text embed, including the 16-skill batches the hook fills its cache with, stays on the default instance, as does indexing (`sync`, `init`, `reindex`, the watcher, `sync_project`) and the skill and tool vector caches: a batch on the lane would take longer than the lane's 400 ms budget and switch it off for everyone.

The lane is not trusted until it is verified. A detached `project-brain lane-verify` compares the two instances' Ollama version, the model's digest, and one probe embedding, which must match exactly; it also loads the model, since a cold load takes longer than a query waits and Ollama abandons a load whose client hung up. Until a verdict exists, and for 15 minutes after a mismatch, queries use the default instance. A verified lane is re-verified every 15 minutes, which catches a `brew upgrade ollama` that restarted only one instance, a model pulled again, or a foreign process on the port. When a verified lane does not answer within 400 ms, the query is retried once on the default instance and the lane is skipped for 60 s. Verdicts live in `~/.project-brain/lane/`, keyed by host and model. `project-brain health` and `check_health` run the same verification and report the lane as `up`, `down`, `mismatch` (with the reason) or `off`.

11435 stays the port because it is the one the setup unit was approved with; the `BRAIN_OLLAMA_HOSTS` example below uses 11436 so a pool built from it does not collide with the lane. A pool member that does sit on 11435 still passes verification only if it is genuinely the same Ollama, model and settings.

`BRAIN_OLLAMA_INTERACTIVE_HOST` overrides the host (`off` disables the lane); `~/.project-brain/ollama.json` with `{ "interactiveHost": "<url>|off" }` does the same when the env var is unset.

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

It is opt-**out**: a non-interactive run installs it by default. Leave it out of the checklist, or pass `--without=guidance:model-routing` (`--no-model-routing` still works as an alias), to skip it. The section carries a content version, so a later release updates it in place instead of leaving you on the text you first accepted.

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

**Report contract.** The skill and the `SessionStart` reminder both ask every delegation to close with a fixed hand-back: verdict (PASS / BLOCKERS / PARTIAL / DONE), changes, test counts, risks and open decisions, in about 400 words, with the full detail written to a file whose path the report gives. A long hand-back stays in the parent's context until it compacts, so the detail belongs on disk. `project-brain setup --with=hooks:report-contract` adds a `PreToolUse` hook that appends the contract to each delegation prompt through `updatedInput`. It never appends twice and leaves alone any prompt that sets its own output shape (JSON, YAML, a schema, an output format, a word cap). It is off by default because it rewrites a prompt the session wrote.

#### Coding rules guard

A `PreToolUse` hook on `Edit`, `Write` and `MultiEdit` that hands an agent the installed `brain-style` skill the first time it edits a code file, so the rules arrive when code is written rather than when a prompt is typed. It reaches sub-agents too: Claude Code fires `PreToolUse` inside them, and the hook keys its once-only memory by session and agent. It is selected by default in `setup` because it is local and warn-only: it exits 0 and adds the rules as `additionalContext`, and fails open on anything it cannot read.

```bash
project-brain setup --with=hooks:style-guard    # already on in a plain `setup`
```

**Which skills apply.** A table maps file extensions to skills (code files to `brain-style`; prose, data and config files to nothing). Only a file the table cannot classify, and only when a TypeSafe token exists, goes to Jev, which sees the file path alone and answers per skill whether it applies; without a token the hook stays silent for those files. The rules text is read from `~/.claude/skills/<skill>/SKILL.md`, so editing the installed skill changes what is injected; if the skill is not installed the hook says nothing.

**Opt out.** Deselect `hooks:style-guard` in `setup`.

#### Architecture guard

A `PreToolUse` hook on `Edit`, `Write` and `MultiEdit` that checks an edit against your architecture boundaries. It is selected by default in `setup` because it is local and warn-only out of the box: the setup unit installs the hook and seeds a **global default** at `~/.project-brain/architecture.json` (hexagonal/clean preset, `"mode": "warn"`), so every project is covered with no per-project step.

```bash
project-brain setup --with=hooks:arch-guard    # hook + global default (already on in a plain `setup`)
project-brain arch init                        # optional: pin a per-project config that overrides the global default
```

**Which config applies.** A project's own `.project-brain/architecture.json` replaces the global one whole, with no merging (even a broken project file means "no check", never a silent fall-through to the global rules). Without one, the global default applies, and a warning or block names it: `(global default: ~/.project-brain/architecture.json)`. The seed is written only when the hook is first installed and the file is absent, so an edited or deliberately deleted global file is never recreated, and removing the unit leaves it in place.

**Opt out.** Deselect `hooks:arch-guard` in `setup`, or set `"mode": "off"` in a config (global to silence every project, or per project to silence one; a project file wins either way).

**The preset.** Only unambiguous folder names: `domain` = `**/domain/**`; `application` = `**/application/**`, `**/use-cases/**`, `**/usecases/**`; `infrastructure` = `**/infrastructure/**`, `**/infra/**`. Names like `core`, `entities` and `adapters` are left out because they mean other things in many trees; add them to the layer globs in your own `.project-brain/architecture.json` if your project uses them that way. Domain may not depend on application or infrastructure; application may not depend on infrastructure. A path matching several layers (`src/infra/domain/x.ts`) belongs to the layer whose matched directory is closest to the file (here `domain`); a tie at the same depth goes to the layer declared first. A project whose paths match no layer is left unchecked.

**Layer rules (deterministic, offline).** `.project-brain/architecture.json` names the layers and what may not depend on what:

```json
{
  "layers": { "domain": "src/domain/**", "application": "src/application/**", "infrastructure": ["src/infra/**", "pkg:pg"] },
  "forbid": [{ "from": "domain", "to": ["application", "infrastructure"] }],
  "mode": "block"
}
```

A layer is a glob or an array of globs; `pkg:<name>` claims a third-party package, which is otherwise in no layer. Only the imports the edit **adds** are judged, so a violation already in the file never blocks an unrelated change. TS/JS (`import`, `export … from`, `require`, literal `import()`), Go (through the `go.mod` module path) and Python are understood; relative specifiers resolve against the edited file, trying extensions and `/index`. `tsconfig` `paths` aliases are not resolved yet. Import syntax is matched in code only, so an import written inside a string, template or docstring is not a dependency. Only an explicit `"mode": "block"` blocks; a missing or unrecognised mode, and a file that is not valid JSON, mean `"warn"`; `"off"` disables the guard, Jev layer included. A warning is delivered to Claude as `additionalContext` next to the tool result, and a malformed file means no check, never a crash.

**Constraints (fuzzy, needs a TypeSafe token).** Any `type: Constraint` concept in `okf/` whose `resource:` anchor covers the edited file is put to Jev as a yes/no question; the edit is blocked when P(violates) is above 0.8. A directory anchor with a trailing slash (`resource: ../src/domain/`) covers every file under it. This layer sends the edit and the constraint text to `api.typesafe.ai`, and only runs when a token resolves (the same one the reranker uses). With no token it is skipped, and a timeout or error lets the edit through. It blocks only when the applying `architecture.json` (project or global) says `"mode": "block"` (the file may hold nothing else); with no file it only warns, so a token you keep for reranking never stops an edit. At most 10 constraints are asked per edit, the most specific anchors first.

The hook reads stdin and fails open on anything it cannot parse. A block exits `2` with the reason on stderr, which Claude Code hands to the model as the retry prompt.

#### Commit check (needs a TypeSafe token)

A `PreToolUse` hook on `Bash` that acts only on `git commit` (including `git -C x commit` and `a && git commit`). One Jev call over the staged diff does two jobs:

- **Review triage.** Yes/no questions: security or permission boundaries, data loss or destructive operations, concurrency or locking, public contract changes. If any has P(yes) above 0.8 (or Jev is down or unsure on a risky-looking diff), Claude is told to run an independent deep review on a stronger model, or ask you, before committing. Jev only escalates: a routine change prints nothing, and silence is never an approval.
- **Test warning.** For staged source files with no staged test, Jev says whether the change is a business rule, bug fix, security boundary or data contract, which is where tests earn their keep. A match is a warning naming the files; nothing is ever required first.

```bash
project-brain setup --with=hooks:commit-check
```

`setup` ticks it by default only when a token is already configured, since the diff (first 16,000 characters) is sent to `api.typesafe.ai`. Without a token, with an empty diff, or on any error or timeout, the Jev part does nothing. Independently of Jev, it names the source files whose staged diff adds comment lines (the `brain-style` rule is zero comments in new code); that check is local, needs no token, and only warns. The default is a warning delivered as `additionalContext`; to make the review escalation block (exit `2`, reason on stderr), write `~/.project-brain/commit-check.json`:

```json
{ "mode": "block" }
```

The test warning never blocks.

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

Also reports the outcome of the last background sync (`.project-brain/sync-status.json`) as a `Last sync:` line — `ok`, `aborted` (the watchdog gave up on a wedged job), `failed`, or `crashed` (the process died mid-run without ever writing a terminal outcome). Anything short of a clean `ok` points at `.project-brain/sync.log`, where the post-commit hook's `sync`/`conceptualize` output actually lands (overwritten on each run, so it always reflects the last one). The `check_health` MCP tool surfaces the same data as a `lastSync` field.

### `status`

Everything left pending across every registered project, in one read-only report. It never changes anything.

```bash
project-brain status [--json] [--project <id>]
```

For each project it lists commits not yet pushed (a branch ahead of its upstream, or a local branch with no upstream that has commits not on the default branch), uncommitted changes in the main checkout, and linked worktrees that `worktree finish` would accept (merged, clean, idle). Globally it lists setup units that are available but not enabled (ones you declined are left out), and compares the installed version with npm's `latest` and `next` dist-tags, flagging when `latest` lags `next`, and lists your live MCP servers that run an older version than the installed one. Each pending item comes with the command that resolves it. A clean project prints nothing; when nothing at all is pending it prints one `All clear` line. Repositories with no remote are not checked for unpushed commits, and the npm lookup gives up after 3 s.

### `stats`

What project-brain put into your Claude Code sessions, per session and per project, read only from local files: nothing is sent anywhere and nothing is written.

```bash
project-brain stats [--days N] [--all] [--json]
```

For each session in the window (default the last 7 days, `--days N` or `--days=N`; only injections and gate drops stamped inside it count) it reports the prompt-context hook's injected blocks (prompts, hits, tokens), the context the Jev context gate dropped (`~/.project-brain/context-gate-log.json`), the tool names and server instructions the session's MCP set holds in context at its largest between compactions (subagents counted apart), and the MCP servers `mcp prune` had disabled for that directory before the session began. The scope is the current project: the initialized project root, else the git repository root, else exactly the current directory, and the header says which; `--all` covers every project. Unknown flags exit with status 2. Every token figure is an estimate, characters divided by 4. `--json` carries counts, sources and scores only, never prompt text.

Per project it also prints a usage signal: of the distinct hits injected, how many the model later read, edited, named in a shell command, or got back from a project-brain tool in the same transcript, and that share at each floor. It is a report, not a calibration. Measured on real transcripts (5,345 injected hits), only 2% were later read, edited or returned by a project-brain tool; counting shell commands, the signal agreed with hand labels only moderately (17 of 36 relevant hits used, 8 of 127 irrelevant). And since only hits above the floor in force are ever injected, it cannot show what a lower floor would add.

### `bench` — measure retrieval quality

Published embedding leaderboards score a different corpus and a different task. A percent-or-two delta on someone else's benchmark says nothing about whether YOUR queries still surface the right file after changing model, dimension or chunking — so `bench` measures against ground truth from *this* repository instead.

```bash
project-brain bench mine [--out .project-brain/bench/queries.jsonl] [--limit N]   # mine ground truth from git history
project-brain bench .project-brain/bench/queries.jsonl [--project <id>] [--pipeline full|hybrid]
```

`bench mine` walks non-merge commits and turns each one into a query: the commit subject (plus a short first body paragraph) as the query, the files it changed as the expected source(s). It skips release/version-bump commits, mass edits (more than ~8 files), and commits that touched only non-indexed files (lockfiles, `package.json`, `CHANGELOG.md`). Deterministic — the same repo history mines the same file every time.

`bench` then runs every query and reports recall@1/5/10 and MRR. `--pipeline hybrid` (default) measures `hybridSearch` alone — the retrieval signal in isolation. `--pipeline full` runs the exact path `search_context` runs (threshold + MMR + token budget), scoring what an agent actually receives, at the cost of conflating retrieval quality with post-processing behavior.

### `search`

Search the indexed context and print compact results. Primarily used internally: `init` installs a `UserPromptSubmit` hook (`project-brain search --stdin`) in `.claude/settings.json` that auto-injects relevant context on every prompt, so retrieval is deterministic rather than relying on the AI to call a tool.

```bash
project-brain search "how does auth work"
echo "how does auth work" | project-brain search --stdin
```

The hook only injects when it is likely to help. Before any embedding work it skips prompts that carry no code question: very short prompts (under 3 words or 15 characters, unless they name a code identifier), acknowledgements and continuations in English and Spanish ("ok", "sí", "continúa", "commit y push"), slash-command echoes, and pasted harness or agent reports. Hits Jev scores below 0.65 are dropped and at most 5 are kept; if nothing survives, nothing is printed. The floor comes from `scripts/calibrate-hook-floor.ts`, which replays your own prompts read-only through the hook's retrieval and Jev (at most 30 requests), writes every hit to a file outside the repository for labelling, and prints precision and recall per floor. The floor is one value for every project and is not adjusted automatically; `project-brain stats` shows it next to how often injected hits were used. The plain CLI `search "<q>"` is not gated.

Hook output stays in the conversation, so a snippet is injected only while it is not already there: the hook reads the newest 8 MB of the session transcript (`transcript_path`), follows the live message chain back from the newest entry, and skips any snippet whose printed text, score aside, an earlier UserPromptSubmit hook output on that chain already holds. When every relevant hit is already there, nothing is printed. The skill/tool suggestion hook does the same per suggested name. Because it reads the live chain, a compaction, `/clear`, `/rewind` or an edited earlier message brings the dropped snippets back on the next prompt, and an unreadable transcript dedups nothing. No state is stored.

| Variable | Default | Effect |
|---|---|---|
| `PROJECT_BRAIN_SEARCH_MIN_SCORE` | `0.65` | Minimum reranker score (0-1) a hit needs to be injected; ignored without a reranker token, where only `PROJECT_BRAIN_SEARCH_MAX_HITS` applies |
| `PROJECT_BRAIN_SEARCH_MAX_HITS` | `5` | Maximum snippets injected |
| `PROJECT_BRAIN_SEARCH_PROMPT_FILTER` | on | Set to `0` to search every prompt, including non-code ones |
| `PROJECT_BRAIN_CONTEXT_DEDUP` | on | Set to `0` to inject snippets and suggestions on every prompt, even when the session already has them |

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
project-brain okf audit --json             # one JSON object instead of prose, for CI/tooling
project-brain okf audit --judge            # ask Claude whether a stale finding's reasoning still holds
```

`--judge` is opt-in and costs money: it sends `claude-opus-5-5` the concept's prose plus the actual code diff, for every `stale` finding where the code moved but the reasoning might not have (never for `uncommitted`, `expired`, or a broken anchor). Needs Anthropic credentials (`ANTHROPIC_API_KEY` or `ant auth login`) — without them the run aborts judging and falls back to the plain, unjudged audit. A "still holds" verdict never auto-attests; it only moves the finding into a non-failing `judged` backlog for a human to confirm with a `verified` entry.

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

#### Live updates

After installing, `update` re-applies your saved `setup` selection with the new binary — no prompts, only the units you chose (a unit you declined is never added, and one never offered is refreshed only if it is already installed). If brew or npm upgraded the binary for you, run `project-brain update --apply-only` to do just that step.

What reaches Claude Code sessions that are already open:

- **Hooks and skills** are live at once: Claude Code reloads `settings.json` and skill directories, and hooks re-run the binary on every event.
- **CLAUDE.md** is only read at launch, so the first prompt after an update shows a one-time notice (`project-brain updated X → Y`) with the current model-routing guidance.
- **The MCP server** is not reloaded by Claude Code, so stdio `serve` moves itself to the new binary (the hot swap below). With the hot swap turned off, the same notice tells you to run `/mcp reconnect all` (or `/mcp`) to load the new tools.

Whenever a server is still on old code, the `check_health` tool says so in its `versionDrift` field (`MCP server runs 0.42.0, installed 0.45.1: run /mcp reconnect ...`, or, when a hot swap to that version failed, the reason it failed), and `project-brain status` lists every live MCP server of yours that runs an older version than the installed one, by pid, with the same fix. Each server records its version under `~/.project-brain/servers/` while it runs, and a record counts only while its pid is still that server; a server too old to have recorded itself is found in the process table and reported when it started before the installed binary was put in place. Without `ps` (Windows) status leaves servers out.

#### Automatic MCP hot swap

Stdio `serve` runs a small supervisor that relays to a worker process. When the binary on disk is newer, it starts a new worker, waits until no request is in flight, switches over, sends `tools/list_changed`, then lets the old worker drain and exit. A failure at any point leaves the old worker serving and is reported by `check_health`: when the new binary does not start, it says so and tells you to reinstall or upgrade again rather than reconnect, since a reconnect would start the same binary. After two failed attempts at a version the supervisor stops trying for that session. A new worker that speaks another MCP protocol version than the session negotiated is refused. If the old worker dies while the new one is ready, the new one takes over instead of the session ending. A retiring worker that is finishing a sync is never killed for it: it marks itself as draining and gets up to 10 minutes; the new worker cannot start indexing meanwhile, because the old one holds the project's `watch.lock` until its sync has finished. Only `serve` gets a supervisor: never `serve --http`, one-shot commands or hooks. The supervisor costs about 16 MB of physical memory per session (measured on macOS, against about 50 MB for the worker), because the release binary is compiled with `--splitting` and the supervisor loads only its own code. Set `BRAIN_MCP_HOT_SWAP=0` in the MCP server's environment to run the server in-process instead; `BRAIN_MCP_HOT_SWAP=1` from before this was the default keeps working. Servers started before the release that made this the default have no supervisor, so that first update still needs one `/mcp reconnect all`.

Limits to know about: a new worker is launched through the same command your tool used (for a brew or npm link, the link, so a retargeted link is picked up), never through the old versioned directory; when running from source with `bun run`, only the entry script is watched, so a change that touches `package.json` alone is not noticed; and a pnpm global install runs project-brain from a versioned `.pnpm/project-brain@<version>` directory that an upgrade leaves in place, so pnpm users still need one `/mcp reconnect` per upgrade.

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
| `BRAIN_CONCEPT_PROVIDER` | `concept.json`, else `anthropic` | Backend `conceptualize` writes module concepts with: `anthropic` (Anthropic API, same credentials as `--judge`), `claude-code` (`claude -p` on your Claude Code login, run with `--safe-mode`, no hooks, plugins, MCP or tools; the diffs still go to Anthropic) or `ollama` (local; waits at most 30s in total for a running `sync` to finish embedding, then skips). An unknown value, or a corrupt `concept.json`, sends nothing rather than falling back to anthropic. Outranks `~/.project-brain/concept.json`, which `setup --concept-provider` writes. |
| `BRAIN_CONCEPT_MODEL` | per backend: `claude-haiku-5-5`, `haiku`, `qwen3.5:4b` | Model `conceptualize` uses, for whichever backend is chosen. Read on each call. Outranks the `model` in `concept.json`, which only applies while the file's provider is the one in use. |
| `BRAIN_SKILL_PICKER` | on | Set to `0` to turn off the Jev skill suggestions the global suggest hook prints, and the per-delegation picks — see [Skill suggestions](#skill-suggestions). Wins over `picker` in `~/.project-brain/skills.json`. |
| `BRAIN_SKILL_PICK_MAX` | `10` | Safety ceiling on skills suggested for one prompt or delegation; wins over `pickCeiling` in `~/.project-brain/skills.json`. |
| `TYPESAFE_API_KEY` | — | Opt-in Jev reranker token — see [Reranking (optional)](#reranking-optional). Checked before `~/.project-brain/reranker.json`; a SessionStart hook exports the stored token under this name to Claude Code sessions. |

## Tuning (environment variables)

`sync`/`reindex` throughput and resilience are tunable independently of the model:

| Variable | Default | Range | Effect |
|---|---|---|---|
| `BRAIN_EMBED_BATCH_SIZE` | `64` | `1`–`512` | Texts per Ollama embed request. Lower it if Ollama times out under load. |
| `BRAIN_EMBED_CONCURRENCY` | `1` | `1`–`16` | Concurrent embed requests. Defaults to `1` — a single local Ollama instance is GPU-compute-bound, so concurrency>1 adds no throughput, only false-timeout risk. Raise it only against a genuine multi-host pool (`BRAIN_OLLAMA_HOSTS`) or remote inference API where separate hardware actually runs requests in parallel. |
| `BRAIN_OLLAMA_HOSTS` | — | comma-separated URLs | Pool of Ollama hosts for round-robin embedding (e.g. `http://127.0.0.1:11434,http://127.0.0.1:11436`). Falls through to the next host on failure; only `null`s when every host fails. |
| `BRAIN_OLLAMA_INTERACTIVE_HOST` | off, or `http://127.0.0.1:11435` once `service:ollama-interactive` is installed | URL or `off` | Ollama host for prompt-time single-query embeds (hooks, `search_context`). Used only after it verifies identical to the default host; falls back to the default host when it does not answer. See [Ollama interactive lane](#ollama-interactive-lane). |
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
