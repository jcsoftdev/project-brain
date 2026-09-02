# Failure

What happens when things go wrong? Gate: auth, external input, or a network boundary was detected.

The test suite proves the happy path. This module walks the other paths — and in most codebases there are more of them.

## Error propagation

- [ ] No swallowed errors: `search_code` for empty catch blocks, `.catch(() => {})`, and `catch` bodies that only log at debug level. Each one converts a failure into wrong behaviour — this is `High` at `read`; `find_callees` on the function containing the catch, or `trace_path` from it to the write operation whose result is lost, promotes it to `traced`, and `Critical`. Rule out a catch guarding a call whose result is provably never consumed anywhere (dead-end telemetry, a best-effort cache warm) before flagging.
- [ ] Caught errors either handle or rethrow: `Read` the catch bodies found above — one that logs and then falls through to the next statement, with no `return`/`throw`, continues execution on invalid state. That is worse than either handling or propagating.
- [ ] Error context survives the chain: `search_code` for `throw new Error(` inside a `catch` block, then read whether it wraps the original (`{ cause: err }`) or discards it. A rethrow that loses the original cause makes the real failure unfindable.
- [ ] Errors are distinguishable by type or code, not by matching message strings: `search_code` for `.message ===`/`.message.includes(` used to branch on an error. Message matching breaks on the next wording change.

## Boundaries

- [ ] Every external call is wrapped: `search_code` for the network/filesystem/subprocess/database client calls (`fetch(`, an HTTP client, `fs.`, `spawn(`, ORM query calls) and confirm each sits inside a try/catch or has a `.catch(`. Rule out a call site covered by a project-wide error-boundary or middleware wrapper (an async-route wrapper, a global `unhandledRejection` handler) — `find_symbol` the wrapper and confirm this call site is inside its scope before flagging the absence of a local try/catch.
- [ ] Every external call has a timeout: `Read` each client construction or call site found above for a `timeout` option or an `AbortSignal.timeout`. Missing timeout is `High` — it turns a slow dependency into an outage. Rule out a framework-level default timeout that applies even without an explicit one, and name it.
- [ ] Retries exist where the failure is transient, are bounded, and back off: `search_code` for a retry wrapper or library around each external call found above; read its config for a max-attempts and a backoff strategy — specifically jittered exponential backoff. Full Jitter (`random(0, min(cap, base*2^attempt))`) is the primary-source recommendation over a fixed interval or un-jittered exponential backoff, since it does the least total work against a recovering backend for comparable completion time (AWS Architecture Blog, "Exponential Backoff and Jitter").
- [ ] Non-transient failures are not retried: `Read` the retry predicate (`shouldRetry`/`retryIf`) at each site found above — retrying unconditionally on any thrown error, including a 4xx, wastes time and hides the bug.
- [ ] Retries are capped by a budget shared across the process, not just a per-call max-attempts count: `search_code` for a retry-budget/limiter (a rolling ratio of retries to total requests, an explicit cap such as "no more than N retries per minute"). Per-call bounding still lets every concurrent caller retry independently, and across a chain of N layers each retrying k times, that multiplies to as many as k^N attempts at the bottom during an incident — the retry-storm mechanism (Google SRE book, "Addressing Cascading Failures").
- [ ] Repeated failures against the same dependency trip a circuit breaker rather than retrying every request into it indefinitely: `search_code` for a circuit-breaker library (resilience4j, Polly's `CircuitBreakerStrategy`, an in-house failure-counter-with-open-state) wrapping the client found above. The pattern is still current guidance — Microsoft's Azure Architecture Center revised its circuit-breaker page as recently as 2026-07-02 — even though Netflix's own Hystrix has been in maintenance mode since 2018 and its README now points to resilience4j; look for the pattern by behaviour, not for a specific library name.

## Partial failure

- [ ] Multi-step operations state what happens when step 3 of 5 fails: `find_symbol` the multi-step function and read it for a transaction wrapper (`BEGIN`/`db.transaction(`) or explicit compensating-action calls after each step. Transaction, compensating action, or documented tolerance — pick one explicitly.
- [ ] Nothing is left half-written: `Read` the same function for later steps that commit independently with no rollback path if an earlier one already succeeded — that is how partial config, orphaned rows, and half-copied directories happen.
- [ ] Operations that touch two systems (a database write paired with a message-broker publish, or a payment-provider call) are not done as two independent calls in the same handler — that shape fails two ways: the DB commits and the publish fails (the event is silently lost, with nothing recording that it should have happened), or the publish succeeds and the DB rolls back (a phantom event fires for a state change that never happened). `search_code` for an `outbox` table written in the same transaction as the business write, with a separate relay or CDC process doing the actual publish — that is the standard fix (the transactional outbox pattern; microservices.io/patterns/data/transactional-outbox.html). Its absence on a DB-write-then-publish handler is the finding regardless of whether a reconciliation job exists elsewhere — reconciliation is a mitigation for drift, not a substitute for atomicity. Cross-reference `Backend`.
- [ ] Batch operations report which items succeeded and which failed: `find_symbol` the batch handler's return shape — a single boolean or `void` return, rather than a per-item results array, is the finding.

## Degradation

- [ ] Optional dependencies failing does not fail the whole operation: `search_code` for an analytics/telemetry/non-critical SDK call inside a critical request handler and confirm it has its own try/catch, separate from the main operation's error path. An analytics outage must not take down a request.
- [ ] There is a defined degraded mode where one exists: `search_code` for a fallback branch on an optional dependency's failure — cached data, a default value, reduced functionality.
- [ ] Degradation is visible: `Read` the fallback branch found above for a log line, metric, or response header signalling degraded mode. Silently serving stale data with no signal is how small outages become long ones.

## User-facing failure

- [ ] Every error the user can hit produces something actionable: `search_code` the error-response construction (a global error handler, an API error formatter) and read its output for specific guidance versus a generic "something went wrong".
- [ ] No stack trace, internal path, SQL, or provider error reaches the user: `Read` the error handler found above for direct serialisation of `err.stack`/`err.message` into the response body, and check whether it is gated by an environment check. That is also an information-disclosure finding — cross-reference `Security`.
- [ ] Failures the user caused are distinguishable from failures the system caused: `Read` the error-class hierarchy or the status-code mapping in the handler above for a distinction (e.g. a validation error mapped to 4xx versus an internal error mapped to 5xx).

## Recovery

- [ ] Restart-safety: the process can be killed at any point and restarted without corruption. `Read` the multi-step write path examined under Partial failure — a write path with no atomic commit is not restart-safe, whether or not the process actually restarts mid-write.
- [ ] Interrupted operations are resumable, or safely re-runnable from the start: `search_code` for a checkpoint mechanism — a stored progress cursor, a job status column — on any long-running operation. Cross-reference the idempotency check in `functional.md`.
- [ ] Anything that can be left in a bad state has a way out: `search_code` docs and the codebase for a repair command, an admin endpoint, or a documented manual procedure ("repair", "runbook", "manual fix"). Its absence means the only way out is direct data surgery.

## Out of static reach

- Whether a given external dependency actually fails in production, and how often.
- Real recovery time after a crash — nothing here is executed.
- Whether an "actionable" error message actually reads as clear to a real user.
- Whether a reconciliation job for a two-system write actually catches drift, versus merely existing in the codebase.
- Behaviour of a documented manual repair procedure when someone runs it under pressure.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number. `browser.md` cannot simulate a 5xx — this closes only what happens when a real one occurs on a walked flow.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl` + `steps.md` | Error state rendered when a request on a walked flow actually returned 5xx | High |

## Severity guidance

| Situation | Severity |
|---|---|
| Swallowed error leading to silent data loss, traced from the catch to the lost write via `find_callees`/`trace_path` (traced) | Critical |
| Missing timeout on an external call | High |
| Multi-step write with no rollback or reconciliation | High |
| Retrying a non-idempotent operation | High |
| Internal error detail leaked to the user | Medium |
| Optional dependency failure taking down the request | Medium |
| Error type distinguished by message string | Medium |
| Silent degradation with no signal | Medium |
| No circuit breaker on a call into a repeatedly-failing dependency | Medium |
| No retry budget — per-call bounded retries still amplify multiplicatively across a call chain | Medium |
| Retry loop with no attempt cap or no backoff/jitter | High |
| Batch reporting only an aggregate result | Low |
