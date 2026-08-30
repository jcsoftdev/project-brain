# Backend

Server-side correctness and structure. Gate: a server framework or API routes were detected.

Orient with `repo_map` first — the highest-ranked symbols in a backend are usually the request pipeline. Then `find_callees` on each handler to see what it actually reaches.

## Request lifecycle

- [ ] Every handler validates its input before using it. `find_callees` from the handler to locate the first read of a request field, then confirm a schema or guard runs before it. Rule out: validation performed by framework middleware attached upstream of the handler — that still counts, it just is not visible inside the handler body.
- [ ] Auth runs before business logic, not inside it. `find_callees` on the handler: the auth/permission check must appear before the first call into a service or domain function, not interleaved after it has already done work.
- [ ] One place owns request→response shape. `search_code` the error-response construction across handlers (a literal like `res.status(`, the framework's error type, or the error-envelope constructor) — more than one shape assembled ad hoc is drift.
- [ ] Long operations do not block the request. `search_code` for a synchronous file, network, or CPU-bound call inside a handler with no queue or background dispatch around it; state the observed or estimated duration if found.

## Layering

- [ ] Handlers do not contain business logic, and business logic does not know about HTTP. `find_callees` on a domain/service function: a domain function reaching a request/response type (`req`, `res`, `Request`, `Response`) is a layering violation.
- [ ] Data access is isolated from business rules. `search_code` for SQL or query-builder literals inside a service/domain file rather than confined to a repository/DAO layer — a service building SQL inline couples two layers that change for different reasons.
- [ ] No circular dependencies between modules. `trace_path` from a module back to itself; a path found is the finding.

## Transactions and consistency

- [ ] Multi-step writes are transactional, or the partial-failure state is explicitly acceptable and documented. `find_callees` on the write function to enumerate its writes, then `search_code` for a `begin`/transaction call wrapping all of them rather than each committing independently.
- [ ] Nothing writes to two systems (DB + queue, DB + external API) without an outbox, retry, or documented tolerance for divergence. `find_callees` on the write path for a second side effect issued after the DB commit with no compensating mechanism between them.
- [ ] Read-modify-write sequences are safe against concurrent execution. `search_code` for a read followed by a write of the same record with no version check or row lock between them — see the `Concurrency` module for the fuller treatment if that gate is also on.

## Configuration and secrets

- [ ] No secret is hardcoded. `search_code` for likely literals: `secret`, `token`, `password`, `api_key`, `Bearer`, matched against a quoted string rather than an env or config read.
- [ ] Every config value has a validated shape and a stated default, or fails loudly at startup rather than at first use. `find_symbol` the config loader and confirm it throws or exits on a missing required value instead of silently returning `undefined`.
- [ ] Environment variables read in code are declared somewhere — cross-check with `Reachability`'s used-but-never-declared sweep rather than re-deriving it here.

## Resource handling

- [ ] Every acquired resource is released on both the success and the error path. `search_code` for the acquire call (`connect(`, `open(`, `lock(`) and confirm a `finally`/`defer`/context-manager releases it, not only a release line on the happy path.
- [ ] Connection pools are bounded and the bound is reachable from config. `search_code` the pool constructor and confirm its size argument is read from config, not a hardcoded literal.
- [ ] Timeouts exist on every outbound call. `search_code` the HTTP/DB client construction and confirm a timeout option is set. A missing timeout is a `High` — it converts a slow dependency into a hung server.

## Out of static reach

- Whether a validation schema is actually sufficient against real malicious input — source confirms a check runs, not that it is strict enough.
- Real request latency, and whether an operation genuinely blocks the event loop under production load rather than only in theory.
- Whether a transaction boundary set in code commits atomically at the database/driver level — that depends on the driver's real behaviour, not the call shape.
- Connection pool exhaustion under real concurrent traffic.
- Whether a startup failure path actually halts the process versus logging a fatal-looking message and continuing to serve traffic.

## Severity guidance

| Situation | Severity |
|---|---|
| Unvalidated input reaching a query or filesystem path | Critical |
| Missing timeout on an outbound call | High |
| Auth check after side effects | High |
| Multi-system write with no reconciliation | High |
| Resource leaked on the error path | Medium |
| Business logic in a handler | Medium |
| Inconsistent error envelope across handlers | Low |
