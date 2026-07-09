import { createServer } from "./server.js";
import type { VectorStore, EmbeddingClient } from "./types.js";

/**
 * Options for the HTTP MCP server.
 */
export interface HttpServerOptions {
  port: number;
  /** Required bearer token — blank/missing causes createHttpServer to reject. */
  token: string;
  dbPath?: string;
  ollamaHost?: string;
  embedModel?: string;
  /** Project root whose .project-brain/graph.db holds the structural graph. Defaults to process.cwd(). */
  projectRoot?: string;
  /** DI: injectable store for tests */
  store?: VectorStore;
  /** DI: injectable embedding client for tests */
  embeddings?: EmbeddingClient;
}

/**
 * Handle returned by createHttpServer.
 * Provides port info and a close() method for graceful shutdown.
 */
export interface HttpServerHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * Pure, port-free, unit-testable auth predicate.
 *
 * Uses a length-guarded constant-time-ish byte compare to reduce timing
 * signal. Returns false for an empty expectedToken (fail-closed).
 *
 * IMPORTANT: This function MUST NOT log, throw, or reference the token value
 * in any way that would expose it to logs or stack traces.
 */
export function authorize(
  headerValue: string | undefined,
  expectedToken: string
): boolean {
  // Fail closed: misconfigured server (empty expected token) never authorizes
  if (!expectedToken) return false;
  if (!headerValue) return false;

  const prefix = "Bearer ";
  if (!headerValue.startsWith(prefix)) return false;

  const presented = headerValue.slice(prefix.length);

  // Length check first (cheap), then constant-time-ish compare
  if (presented.length !== expectedToken.length) return false;

  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expectedToken.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Create an HTTP MCP server that exposes the same tools as the stdio server
 * behind bearer-token authentication.
 *
 * Uses WebStandardStreamableHTTPServerTransport (Bun-native Web Standards path)
 * directly since Bun fully supports the Fetch API / Web Standards.
 *
 * The server is NOT bound to a port until start() is called on the returned handle.
 * (In this design, the Bun.serve() call happens inside createHttpServer and the
 * handle's close() stops the server.)
 */
export async function createHttpServer(
  opts: HttpServerOptions
): Promise<HttpServerHandle> {
  const { token, port: requestedPort } = opts;

  // Validate token — reject immediately if blank (HTTP-4a)
  if (!token || !token.trim()) {
    throw new Error(
      "createHttpServer: token is required. Set BRAIN_HTTP_TOKEN to a non-empty value."
    );
  }

  // Import SDK transport — verified import path for SDK 1.29:
  // @modelcontextprotocol/sdk/server/streamableHttp.js resolves via ./* wildcard to
  // ./dist/esm/server/streamableHttp.js which exports StreamableHTTPServerTransport.
  // However, since Bun supports Web Standards natively we use WebStandardStreamableHTTP
  // directly for a cleaner integration without the Node.js HTTP bridge.
  const { WebStandardStreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
  );

  // Create the MCP server (registers all 11 tools via createServer — ADR-1).
  // Capture `graph` so close() can release the SQLite/WAL handle the server owns.
  const { server, graph } = await createServer({
    dbPath: opts.dbPath,
    ollamaHost: opts.ollamaHost,
    embedModel: opts.embedModel,
    projectRoot: opts.projectRoot,
  });

  // Stateless transport (no session management needed for basic HTTP access)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  // Connect MCP server to transport
  await server.connect(transport);

  // Build the Bun HTTP server — auth middleware runs BEFORE transport
  const bunServer = Bun.serve({
    port: requestedPort,
    fetch: async (req: Request): Promise<Response> => {
      // Bearer auth check — NEVER log token or Authorization header value
      const authHeader = req.headers.get("authorization") ?? undefined;
      if (!authorize(authHeader, token)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Forward to MCP transport
      return transport.handleRequest(req);
    },
  });

  // bunServer.port is typed number | undefined in bun-types, but Bun.serve()
  // always sets it once the server is listening — treat undefined here as an
  // invariant violation rather than silently reporting requestedPort, which
  // would be 0 (wrong) whenever the caller asked for an ephemeral port.
  if (bunServer.port === undefined) {
    throw new Error("Bun.serve() did not report a bound port");
  }

  return {
    // Report the actually-bound port (matters when port 0 = ephemeral).
    port: bunServer.port,
    async close(): Promise<void> {
      await transport.close();
      bunServer.stop(true);
      // Release the shared SQLite/WAL handle owned by this server (matches the
      // stdio path's createShutdownHandler, which closes graph after teardown).
      try { graph.close(); } catch {}
    },
  };
}
