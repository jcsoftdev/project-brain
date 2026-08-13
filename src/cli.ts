#!/usr/bin/env bun

const [command, ...args] = process.argv.slice(2);

// Update notifier: instant (reads a cached result only, no network) and
// fail-silent. Skipped for hidden/internal commands so the detached background
// refresh never re-triggers itself. Opt out with BRAIN_NO_UPDATE_CHECK=1.
// `--version` is on this list because scripts/install.sh runs it to smoke-test a
// freshly downloaded binary, and the Homebrew formula asserts on its output. It
// has to be a bare, side-effect-free print: no network, no skill writes.
const SKIPS_PREAMBLE = [
  "__update-check",
  "__parse-selftest",
  "__extract-selftest",
  "--version",
  "-v",
];

if (!SKIPS_PREAMBLE.includes(command as string)) {
  try {
    const { notifyIfUpdateAvailable } = await import("./notifier.js");
    notifyIfUpdateAvailable();
  } catch {
    /* fail-silent — never let the notifier break a command */
  }

  // Bring already-installed skills up to this build's content.
  //
  // Deliberately NOT chained onto `update`: someone who upgrades with
  // `brew upgrade`, or by dropping in a binary, never runs `update` at all.
  // Comparing what is on disk against what is in this binary is the only check
  // that works for every install channel. Only refreshes directories setup
  // already created, and only while it can prove they are ours — it never
  // installs. Opt out with BRAIN_NO_SKILL_REFRESH=1.
  if (!process.env.BRAIN_NO_SKILL_REFRESH) {
    try {
      const { refreshStaleSkills, knownSkillRoots } = await import("./rules/skills.js");
      const { refreshed, added } = await refreshStaleSkills(knownSkillRoots());
      if (refreshed.length > 0) {
        console.error(`  project-brain: refreshed ${refreshed.length} skill(s) to match this version`);
      }
      // Reported separately from a refresh: a skill appearing for the first
      // time is news, and the host may need a reload before it is usable.
      if (added.length > 0) {
        console.error(`  project-brain: installed ${added.length} new skill(s) — reload your agent to pick them up`);
      }
    } catch {
      /* fail-silent — a skills directory must never break a command */
    }
  }
}

function printHelp() {
  console.log(`project-brain — MCP server for codebase knowledge

Usage: project-brain [command]
Env: BRAIN_EMBED_BATCH_SIZE, BRAIN_EMBED_CONCURRENCY, BRAIN_OLLAMA_HOSTS, BRAIN_EMBED_MODEL,
     BRAIN_SYNC_WINDOW_FILES (see README "Tuning")

Commands:
  serve              Start MCP server over stdio (default)
  serve --http       Start MCP server over HTTP with bearer auth
  setup              One-time global setup (detect env, register in AI tools)
                       --model-routing / --no-model-routing  force the model-routing prompt answer
  init               Initialize project (detect stack, index, install hook)
  sync               Incremental sync (re-index changed files)
  conceptualize      Update conceptual module docs from the latest commit
  reindex            Full re-index (drop + rebuild)
  health             Check system health and staleness
  search "<query>"   Search indexed context (used by hooks); prints compact results
  update             Update project-brain to the latest published version

Knowledge bundles (Open Knowledge Format v0.2 — the *why*, not the *what*):
  okf validate [dir]       Check bundle conformance (SPEC §11). Offline.
  okf sync [dir]           Index the bundle's concepts so search_context returns them
  okf audit [dir]          Cross-check the bundle against the code graph:
                             broken anchors, knowledge older than the code it
                             explains, important code nothing documents, and
                             concepts whose code calls across them but whose
                             prose does not
    --symbol <name>        Name the concepts to re-read after <name> changes
                             dir defaults to ./okf

Structural (offline — no Ollama probe, reads the local graph.db directly):
  find <name>              Exact symbol lookup by name
  callers <name>           Every symbol that calls <name>
  callees <name>           Every symbol <name> calls
  impact <name>            Blast radius (transitive callers), [--max-depth N] (default 6, max 20)
  trace <from> <to>        Shortest call path from <from> to <to>, [--max-depth N] (default 8, max 20)
  map                      Token-budgeted repo overview, [--budget N] [--focus a,b,c]
  code "<query>"           Keyword/BM25 code search (no embeddings needed), [--limit N] (default 10, max 50)

Options for serve --http:
  --port <n>         HTTP listen port (default: 3000; env: BRAIN_HTTP_PORT)
  BRAIN_HTTP_TOKEN   Required env var — bearer secret for HTTP auth

Options:
  --help, -h     Show this help message
  --version, -v  Print the installed version
`);
}

switch (command) {
  case undefined:
  case "serve": {
    if (args.includes("--http")) {
      // HTTP transport with bearer-token authentication
      const { parsePort } = await import("./cli-args.js");
      const port = parsePort(args);
      const token = process.env.BRAIN_HTTP_TOKEN ?? "";
      if (!token.trim()) {
        console.error("serve --http requires BRAIN_HTTP_TOKEN to be set");
        process.exit(1);
      }
      const { createHttpServer } = await import("./server-http.js");
      const dbPath = process.env.BRAIN_DATA_DIR || undefined;
      const embedModel = process.env.BRAIN_EMBED_MODEL || undefined;
      const handle = await createHttpServer({ port, token, dbPath, embedModel });
      console.log(`project-brain HTTP server listening on port ${handle.port}`);
      process.on("SIGINT", () => handle.close().then(() => process.exit(0)));
      process.on("SIGTERM", () => handle.close().then(() => process.exit(0)));
      // Keep the process alive — Bun.serve() keeps the event loop open
    } else {
      // Default stdio transport
      const { StdioServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/stdio.js"
      );
      const { createServer } = await import("./server.js");
      const { maybeStartWatcher, createShutdownHandler } = await import(
        "./serve.js"
      );
      const { ORPHAN_CHECK_MS } = await import("./constants.js");
      const dbPath = process.env.BRAIN_DATA_DIR || undefined;
      const embedModel = process.env.BRAIN_EMBED_MODEL || undefined;
      const cwd = process.cwd();
      const { server, store, embeddings, graph, foreignGraphs } = await createServer({ dbPath, embedModel, projectRoot: cwd });

      // Attempt to start file watcher if project config exists.
      // Pass the server's shared graph so the watcher writes the SAME graph.db.
      const watcher = await maybeStartWatcher(cwd, { store, embeddings, graph });

      // Graceful shutdown — closes the shared graph connection AND every
      // foreign project graph the structural tools opened along the way.
      const shutdown = createShutdownHandler(watcher, undefined, [graph, foreignGraphs]);
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // A stdio server's lifetime is its client's, and signals alone do not
      // enforce that. A host that crashes or is force-quit sends nothing, the
      // watcher keeps the event loop alive, and the server runs forever.
      // Measured before this existed: 19 live servers on one machine, 6 of them
      // orphaned to init, the oldest up 3 days, each holding ~3 GB and serving
      // nobody. Across several projects and tools that is the whole machine.
      //
      // Watching the PARENT rather than stdin, for two reasons found by testing:
      // the SDK's stdio transport subscribes only to `data` and `error` and
      // never observes EOF, and adding our own stdin listener broke the
      // handshake outright — the server answered nothing, reproduced 3/3 against
      // a real `initialize` while the unmodified build answered 3/3. The
      // transport counts stdin listeners to decide whether to pause the stream,
      // so it is not a stream to share.
      //
      // process.ppid is cached in Bun and never changes on adoption, so polling
      // it is useless; asking whether the ORIGINAL parent still exists is the
      // check that works. Signal 0 performs the permission and existence test
      // without delivering anything.
      //
      // The pid to watch is the CLIENT's, which is not always our parent. The
      // npm install path puts `bin/project-brain` in between: it runs this
      // binary through execFileSync and blocks, so our parent is that shim. If
      // the AI tool dies while the shim sits blocked, a parent check sees a live
      // parent and we leak anyway. The shim hands its own parent down as
      // BRAIN_CLIENT_PID precisely so we watch the tool instead. Fixing this end
      // fixes the pair — once we exit, execFileSync returns and the shim exits.
      const parentPid = Number(process.env.BRAIN_CLIENT_PID) || process.ppid;
      const orphanCheck = setInterval(() => {
        try {
          process.kill(parentPid, 0);
        } catch {
          shutdown();
        }
      }, ORPHAN_CHECK_MS);
      // Never hold the loop open on this timer's account — it exists to end the
      // process, not to keep it running.
      orphanCheck.unref?.();

      const transport = new StdioServerTransport();
      await server.connect(transport);
    }
    break;
  }
  case "setup": {
    const { execute } = await import("./commands/setup.js");
    await execute(args);
    break;
  }
  case "init": {
    const { execute } = await import("./commands/init.js");
    await execute(args);
    break;
  }
  // Hook entry points. Not for humans — these are the commands `setup` writes
  // into Claude Code's settings.json.
  case "routing-rules": {
    const { execute } = await import("./hooks/routing-rules.js");
    await execute();
    break;
  }
  case "routing-guard": {
    const { execute } = await import("./hooks/routing-guard.js");
    await execute();
    break;
  }
  case "sync": {
    const { execute } = await import("./commands/sync.js");
    await execute(args);
    break;
  }
  case "conceptualize": {
    const { execute } = await import("./commands/conceptualize.js");
    await execute(args);
    break;
  }
  case "reindex": {
    const { execute } = await import("./commands/reindex.js");
    await execute(args);
    break;
  }
  case "health": {
    const { execute } = await import("./commands/health.js");
    await execute(args);
    break;
  }
  case "search": {
    const { execute } = await import("./commands/search.js");
    await execute(args);
    // search.ts's internal 4000ms race only decides what execute()'s own
    // promise resolves to — it does NOT cancel the losing side or kill the
    // process. Without forcing exit here, a slow/hung Ollama call left
    // running in the background keeps this process alive well past the
    // race (observed: 10s+ in createEmbeddingClient alone), defeating the
    // whole point of the hook's "must never hang a prompt" guarantee.
    process.exit(0);
    break;
  }
  case "update": {
    const { execute } = await import("./commands/update.js");
    await execute(args);
    break;
  }
  case "find": {
    const { execute } = await import("./commands/find.js");
    await execute(args);
    break;
  }
  case "callers": {
    const { execute } = await import("./commands/callers.js");
    await execute(args);
    break;
  }
  case "callees": {
    const { execute } = await import("./commands/callees.js");
    await execute(args);
    break;
  }
  case "impact": {
    const { execute } = await import("./commands/impact.js");
    await execute(args);
    break;
  }
  case "trace": {
    const { execute } = await import("./commands/trace.js");
    await execute(args);
    break;
  }
  case "map": {
    const { execute } = await import("./commands/map.js");
    await execute(args);
    break;
  }
  case "code": {
    const { execute } = await import("./commands/code.js");
    await execute(args);
    break;
  }
  case "okf": {
    const { execute } = await import("./commands/okf.js");
    await execute(args);
    break;
  }
  case "__parse-selftest": {
    // Hidden build-smoke hook (not in --help). Ollama-free: proves the
    // cross-compiled binary loaded the embedded WASM grammar + produced
    // symbols. Used by .github/workflows/release.yml. See parse-selftest.ts.
    const { execute } = await import("./commands/parse-selftest.js");
    await execute(args);
    break;
  }
  case "__extract-selftest": {
    // Hidden build-smoke hook (not in --help). Ollama-free: proves the
    // cross-compiled binary bundles + can run unpdf/mammoth/exceljs and
    // extract pdf/docx/xlsx content. Used by .github/workflows/release.yml.
    // See extract-selftest.ts.
    const { execute } = await import("./commands/extract-selftest.js");
    await execute(args);
    break;
  }
  case "__update-check": {
    // Hidden command run detached by the update notifier to refresh its cache
    // (latest published version) for the next invocation. Fail-silent.
    const { execute } = await import("./commands/update-check.js");
    await execute();
    break;
  }
  case "--version":
  case "-v": {
    const { VERSION } = await import("./constants.js");
    console.log(`project-brain ${VERSION}`);
    process.exit(0);
    break;
  }
  case "--help":
  case "-h":
    printHelp();
    process.exit(0);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error(
      "Usage: project-brain [setup|init|sync|conceptualize|reindex|health|search|update|serve|find|callers|callees|impact|trace|map|code|okf]"
    );
    process.exit(1);
}
