#!/usr/bin/env bun

const [command, ...args] = process.argv.slice(2);

function printHelp() {
  console.log(`project-brain — MCP server for codebase knowledge

Usage: project-brain [command]

Commands:
  serve              Start MCP server over stdio (default)
  serve --http       Start MCP server over HTTP with bearer auth
  setup              One-time global setup (detect env, register in AI tools)
  init               Initialize project (detect stack, index, install hook)
  sync               Incremental sync (re-index changed files)
  reindex            Full re-index (drop + rebuild)
  health             Check system health and staleness
  search "<query>"   Search indexed context (used by hooks); prints compact results

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
      const port = Number(
        args[args.indexOf("--port") + 1] ??
        process.env.BRAIN_HTTP_PORT ??
        3000
      );
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
  case "--help":
  case "-h":
    printHelp();
    process.exit(0);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error(
      "Usage: project-brain [setup|init|sync|reindex|health|search|serve]"
    );
    process.exit(1);
}
