# Backend

Server-side correctness and structure. Gate: a server framework or API routes were detected.

Orient with `repo_map` first — the highest-ranked symbols in a backend are usually the request pipeline. Then `find_callees` on each handler to see what it actually reaches.

## Request lifecycle

- [ ] Every handler validates its input before using it. Trace from the route to the first use of a request field.
- [ ] Auth runs before business logic, not inside it. A handler that checks permissions halfway through has already done work it may not be allowed to do.
- [ ] One place owns request→response shape. Handlers that each hand-roll their own error envelope will drift.
- [ ] Long operations do not block the request. If they do, state the observed or estimated duration.

## Layering

- [ ] Handlers do not contain business logic, and business logic does not know about HTTP. Check with `find_callees`: a domain function reaching a request/response type is a layering violation.
- [ ] Data access is isolated from business rules. A service building SQL inline couples two layers that change for different reasons.
- [ ] No circular dependencies between modules. `trace_path` from a module back to itself.

## Transactions and consistency

- [ ] Multi-step writes are transactional, or the partial-failure state is explicitly acceptable and documented.
- [ ] Nothing writes to two systems (DB + queue, DB + external API) without an outbox, retry, or documented tolerance for divergence.
- [ ] Read-modify-write sequences are safe against concurrent execution — see the `Concurrency` module if that gate is also on.

## Configuration and secrets

- [ ] No secret is hardcoded. `search_code` for likely literals: `secret`, `token`, `password`, `api_key`, `Bearer`.
- [ ] Every config value has a validated shape and a stated default, or fails loudly at startup rather than at first use.
- [ ] Environment variables read in code are declared somewhere — cross-check with `Reachability`'s used-but-never-declared sweep.

## Resource handling

- [ ] Every acquired resource is released on both the success and the error path — connections, file handles, locks, DB transactions.
- [ ] Connection pools are bounded and the bound is reachable from config.
- [ ] Timeouts exist on every outbound call. A missing timeout is a `High` — it converts a slow dependency into a hung server.

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
