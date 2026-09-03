# Backend

Server-side correctness and structure. Gate: a server framework or API routes were detected.

Orient with `repo_map` first — the highest-ranked symbols in a backend are usually the request pipeline. Then `find_callees` on each handler to see what it actually reaches.

## Request lifecycle

- [ ] Every handler validates its input before using it. `find_callees` from the handler to locate the first read of a request field, then confirm a schema or guard runs before it. Rule out: validation performed by framework middleware attached upstream of the handler — that still counts, it just is not visible inside the handler body.
- [ ] Auth runs before business logic, not inside it. `find_callees` on the handler: the auth/permission check must appear before the first call into a service or domain function, not interleaved after it has already done work.
- [ ] One place owns request→response shape. `search_code` the error-response construction across handlers (a literal like `res.status(`, the framework's error type, or the error-envelope constructor) — more than one shape assembled ad hoc is drift. RFC 9457 defines a standard `type`/`title`/`status`/`detail`/`instance` shape "so that [APIs] aren't required to define their own... or... redefine the semantics of existing HTTP status codes" (IETF, RFC 9457, 2023, https://www.rfc-editor.org/rfc/rfc9457) — Express's own single last-registered error handler (OpenJS Foundation, Express.js guide, current, https://expressjs.com/en/guide/error-handling.html) and NestJS's built-in exceptions layer (NestJS team, official documentation, current, https://docs.nestjs.com/exception-filters) are two frameworks' own mechanisms for enforcing exactly one shape.
- [ ] Error responses carry a fixed, documented set of keys (a `type`/`title`/`status`/`detail` problem object or the framework's structured equivalent) rather than a bare string or a shape that differs per handler. `search_code` the error-response construction across handlers (same probe as the check above) and confirm the emitted keys are the same set everywhere. Refuted if the endpoint is an internal RPC consumed only by a client committed in the same repository — RFC 9457's interoperability concern doesn't apply between two ends of one codebase (IETF, RFC 9457, 2023, https://www.rfc-editor.org/rfc/rfc9457).
- [ ] Long operations do not block the request. `search_code` for a synchronous file, network, or CPU-bound call inside a handler with no queue or background dispatch around it — a loop over unbounded input, an unindexed query, or a known-slow client call is the concrete signal; state the observed or estimated duration as part of the finding, not only when convenient. Synchronous core APIs, ReDoS-prone regexes, and large `JSON.parse`/`JSON.stringify` block the event loop, and "while a thread is blocked working on behalf of one client, it cannot handle requests from any other clients" (Node.js project, "Don't Block the Event Loop" guide, current, https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop).
- [ ] The process registers a handler for unhandled promise rejections and uncaught exceptions (`process.on('unhandledRejection', ...)`/`uncaughtException`, or the framework's equivalent) that logs and exits deliberately, rather than leaving a rejected promise to silently hang a request or crash on a future Node default-behavior change. `search_code` for `unhandledRejection`/`uncaughtException` at the process entrypoint. Refuted if a supervisor (pm2, systemd `Restart=always`, Kubernetes `restartPolicy`) auto-restarts the crashed process with no more than the one in-flight request lost — name the supervisor and confirm restart-on-crash is actually configured before treating a missing handler as more than a bounded, single-request risk. The `unhandledRejection` event fires when a Promise rejects with no handler attached, and default behaviour has tightened release over release toward treating it as an uncaught exception (Node.js project, official API docs, current, https://nodejs.org/api/process.html#event-unhandledrejection).
- [ ] Under a traffic spike the service sheds or degrades excess requests rather than accepting all of them and failing every in-flight one. `search_code` for a concurrency or rate limiter mounted ahead of the handlers (e.g. `express-rate-limit`, a semaphore, a bounded queue); its absence, on a service with no known upstream gateway already doing this, is the finding. Refuted if load shedding is delegated to infrastructure this repo doesn't own — an API gateway or managed load balancer with its own concurrency limits — confirmed via `search_code` on infra-as-code files. A backend "provisioned to serve a certain traffic rate should continue to serve traffic at that rate... regardless of how much excess traffic is thrown at the task," accepting only what it can process and rejecting the rest gracefully (Google, Site Reliability Engineering book, "Handling Overload," current, https://sre.google/sre-book/handling-overload/).

## Layering

- [ ] Handlers do not contain business logic, and business logic does not know about HTTP. `find_callees` on a domain/service function: a domain function reaching a request/response type (`req`, `res`, `Request`, `Response`) is a layering violation.
- [ ] Data access is isolated from business rules. `search_code` for SQL or query-builder literals inside a service/domain file rather than confined to a repository/DAO layer — a service building SQL inline couples two layers that change for different reasons.
- [ ] Circular dependencies between modules — owned by `complexity.md` (`trace_path` from a module back to itself); reuse its finding, do not re-report.
- [ ] A conditional branch guarded by a flag, toggle, or environment check that no live caller ever sets to take the other path is deleted, not left in place for a future flag reuse to silently reactivate. `find_callers` on the flag/toggle variable to confirm every current caller sets it the same way; use `impact` on the dead branch to see what it would touch if reactivated. Escalate to `High` only when `impact` traces the dead branch to a write path. Refuted if the flag is a live, intentionally-toggled feature flag (owned by `feature-flags.md`) rather than genuinely dead code — check its declaration/registration point before concluding it is unused.

## Transactions and consistency

- [ ] Multi-step writes are transactional, or the partial-failure state is explicitly acceptable and documented. `find_callees` on the write function to enumerate its writes, then `search_code` for a `begin`/transaction call wrapping all of them rather than each committing independently.
- [ ] Nothing writes to two systems (DB + queue, DB + external API) without an outbox, retry, or documented tolerance for divergence. `find_callees` on the write path for a second side effect issued after the DB commit with no compensating mechanism between them.
- [ ] Read-modify-write sequences are safe against concurrent execution — owned by `concurrency.md` for the in-process/cache case (`search_code` for a read followed by a write of the same in-memory field with no atomic op or compare-and-swap between them) and by `database.md` for the DB-row case (`search_code` for a `SELECT` immediately followed by an `INSERT`/`UPDATE` on the same row with no version check or row lock); reuse whichever finding applies, do not re-report.

## Configuration and secrets

- [ ] No secret is hardcoded — owned by `security.md` (`search_code` for `secret`, `token`, `password`, `api_key`, `Bearer` literals matched against a quoted string rather than an env/config read); reuse its finding, do not re-report. Config must be strictly separated from code so a codebase is safe to open-source immediately with no exposed credentials (Adam Wiggins, 12factor.net, current, https://12factor.net/config).
- [ ] Every config value has a validated shape and a stated default, or fails loudly at startup rather than at first use. `find_symbol` the config loader and confirm it throws or exits on a missing required value instead of silently returning `undefined`. A config file not tracked in version control is itself criticised as easily committed by accident (Adam Wiggins, 12factor.net, current, https://12factor.net/config).
- [ ] Environment variables read in code are declared somewhere — `search_code` each `process.env.`/`os.environ`/config-read literal and cross-check with `Reachability`'s used-but-never-declared sweep rather than re-deriving it here. Strict separation of config from code is the 12-factor contract this declaration sweep enforces (Adam Wiggins, 12factor.net, current, https://12factor.net/config).
- [ ] No log call passes a raw password, token, session identifier, or PII field as an argument. `search_code` for a logger call (`log(`, `console.log(`, `logger.info(`, `logger.error(`) whose arguments include a variable literally named `password`/`token`/`secret`/`apiKey`/`session`, or the whole request/user object, rather than a redacted projection of it. Refuted if the logger has a configured redaction/masking transform covering exactly those field names before the sink (e.g. Pino `redact`, a Winston format) — confirm the transform's field list actually covers the flagged call before treating it as exposed. Passwords, encryption keys, session identifiers, access tokens, and sensitive PII must be "removed, masked, sanitized, hashed, or encrypted" before logging (OWASP, Logging Cheat Sheet, current, https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).

## API compatibility

- [ ] A response-shape change is guarded by a version discriminator (a header, a URL segment, or a per-caller pin) so existing external callers keep receiving the shape they integrated against. `search_code` the request pipeline for a version-reading step; its complete absence on an API with callers outside this repo is the finding — `Low`, or `Info` if `api.md` runs in the same audit and already owns this. Coordinate with `api.md` before reporting — this may already be that module's finding. Refuted if the API has no external callers, deployed and consumed atomically within this repo. Stripe auto-pins every account to the version current on its first API call, and serves every later call that same version implicitly, specifically so "fields that were present before... stay present" for already-integrated callers (Stripe engineering, official blog, current, https://stripe.com/blog/api-versioning).

## Resource handling

- [ ] Every acquired resource is released on both the success and the error path. `search_code` for the acquire call (`connect(`, `open(`, `lock(`) and confirm a `finally`/`defer`/context-manager releases it, not only a release line on the happy path.
- [ ] The process handles SIGTERM by stopping acceptance of new requests, letting in-flight ones finish, then exiting — not left for the orchestrator's SIGKILL once the grace period elapses. `search_code` for `SIGTERM`/`process.on('SIGTERM'`/a framework shutdown hook (NestJS `enableShutdownHooks`, `server.close(`); its complete absence on a service meant to run under an orchestrator or PaaS is the finding. Refuted if the deployment target itself drains connections at the load-balancer layer before ever delivering SIGTERM to the process, or a supervisor is configured to redirect traffic away first — confirm no handler exists anywhere in the call graph from the server's `listen()` (`find_callers`) before treating the absence as the finding. Processes must "shut down gracefully when they receive a SIGTERM signal," ceasing to listen and letting current requests finish before exiting (Adam Wiggins, 12factor.net, current, https://12factor.net/disposability); a missing handler forfeits exactly the mechanism Kubernetes assumes — `terminationGracePeriodSeconds` defaults to 30 seconds, SIGTERM first, SIGKILL once it elapses (Kubernetes project, Pod Lifecycle documentation, current, https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination).
- [ ] Connection pools are bounded and the bound is reachable from config. `search_code` the pool constructor and confirm its size argument is read from config, not a hardcoded literal.
- [ ] Timeouts exist on every outbound call — owned by `failure.md` (`search_code` the client construction for a timeout option or `AbortSignal.timeout`); reuse its finding, do not re-report.

## Out of static reach

- Whether a validation schema is actually sufficient against real malicious input — source confirms a check runs, not that it is strict enough.
- Real request latency, and whether an operation genuinely blocks the event loop under production load rather than only in theory.
- Whether a transaction boundary set in code commits atomically at the database/driver level — that depends on the driver's real behaviour, not the call shape.
- Connection pool exhaustion under real concurrent traffic.
- Whether a startup failure path actually halts the process versus logging a fatal-looking message and continuing to serve traffic.
- Whether the SIGTERM handler reliably completes within the real grace period under production traffic — this module confirms the handler exists, not that it always wins the race against SIGKILL.
- Whether a specific breaking change was actually gated behind the version discriminator this module confirms exists — that requires a version-by-version response diff, not just confirming the mechanism is present.
- Whether missing load-shedding in this service actually cascades to its callers or dependencies in production — that requires observing the whole dependent system under real overload, not this one repository.
- Whether the per-process pool bound is safe once every deployed replica's own pool is summed — this module confirms the bound is config-driven, not the cluster-wide total against the database's real limit.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl` | Real request duration for a server operation reached through a driven UI flow — bounded to the timing observed for that call, not a diagnosis of genuine event-loop blocking versus other latency causes | Low |
| `network.jsonl` (status codes + request sequence), `steps.md` | Auth ordering confirmed live: a protected endpoint returns 401/403 before any state-changing request for the same flow appears. Refuted if a side effect could occur through a channel outside `network.jsonl` (e.g. a server-side queued job with no client-visible request) — observed only for the client-visible side effect, not the full server-side chain. | High (parallel to "Auth check after side effects") |
| `network.jsonl` response bodies for failed requests | Error body shape observed live matches (or diverges from) one consistent envelope across two or more driven flows. Refuted if a diverging shape belongs to a third-party or proxied endpoint this backend doesn't own — cross-check the request host in `network.jsonl` before attributing the drift here. | Low |
| `network.jsonl` response time + `vitals.md`, for the specific flow that exercises the flagged handler | Long-operation flag (static check) corroborated by real duration on a driven flow. Refuted if the slow response is dominated by downstream/third-party latency the trace can separate out (`insights.md`/`trace.json`), not server-side blocking. | Low |

## Severity guidance

| Situation | Severity |
|---|---|
| Unvalidated input reaching a query or filesystem path | Critical |
| Auth check after side effects | High |
| Multi-system write with no reconciliation | High |
| Dead branch behind a repurposed flag, `impact`-traced to a write path | High |
| No log call redaction on a raw secret, token, or PII field | High |
| Missing SIGTERM handler on a service meant to run under an orchestrator or PaaS | High |
| Resource leaked on the error path | Medium |
| Business logic in a handler | Medium |
| No process-level unhandled-rejection/uncaught-exception handler | Medium |
| No load-shedding or concurrency ceiling ahead of the handlers | Medium |
| Dead branch behind a repurposed flag, no traced write path | Medium |
| Inconsistent error envelope across handlers | Low |
| Error responses with no fixed machine-readable key set | Low |
| Missing API version discriminator with external callers | Low |
