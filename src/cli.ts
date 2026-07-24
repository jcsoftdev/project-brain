#!/usr/bin/env bun

const [command, ...args] = process.argv.slice(2);

// Update notifier: instant (reads a cached result only, no network) and
// fail-silent. Skipped for hidden/internal commands so the detached background
// refresh never re-triggers itself. Opt out with BRAIN_NO_UPDATE_CHECK=1.
if (command !== "__update-check" && command !== "__parse-selftest") {
  try {
    const { notifyIfUpdateAvailable } = await import("./notifier.js");
    notifyIfUpdateAvailable();
  } catch {
    /* fail-silent — never let the notifier break a command */
  }
}

function printHelp() {
  console.log(`project-brain — MCP server for codebase knowledge

Usage: project-brain [command]
Env: BRAIN_EMBED_BATCH_SIZE, BRAIN_EMBED_CONCURRENCY, BRAIN_OLLAMA_HOSTS, BRAIN_EMBED_MODEL (see README "Tuning")

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

Options for serve --http:
  --port <n>         HTTP listen port (default: 3000; env: BRAIN_HTTP_PORT)
  BRAIN_HTTP_TOKEN   Required env var — bearer secret for HTTP auth

Options:
  --help, -h  Show this help message
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
      const dbPath = process.env.BRAIN_DATA_DIR || undefined;
      const embedModel = process.env.BRAIN_EMBED_MODEL || undefined;
      const cwd = process.cwd();
      const { server, store, embeddings, graph } = await createServer({ dbPath, embedModel, projectRoot: cwd });

      // Attempt to start file watcher if project config exists.
      // Pass the server's shared graph so the watcher writes the SAME graph.db.
      const watcher = await maybeStartWatcher(cwd, { store, embeddings, graph });

      // Graceful shutdown — also close the shared graph connection.
      const shutdown = createShutdownHandler(watcher, undefined, graph);
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

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
  case "__parse-selftest": {
    // Hidden build-smoke hook (not in --help). Ollama-free: proves the
    // cross-compiled binary loaded the embedded WASM grammar + produced
    // symbols. Used by .github/workflows/release.yml. See parse-selftest.ts.
    const { execute } = await import("./commands/parse-selftest.js");
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
  case "--help":
  case "-h":
    printHelp();
    process.exit(0);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error(
      "Usage: project-brain [setup|init|sync|conceptualize|reindex|health|search|update|serve]"
    );
    process.exit(1);
}
