# Failure

What happens when things go wrong? Gate: auth, external input, or a network boundary was detected.

The test suite proves the happy path. This module walks the other paths — and in most codebases there are more of them.

## Error propagation

- [ ] No swallowed errors. `search_code` for empty catch blocks, `.catch(() => {})`, and `catch` bodies that only log at debug level. Each one converts a failure into wrong behaviour.
- [ ] Caught errors either handle or rethrow. Catching to log and continue with invalid state is the worst of both.
- [ ] Error context survives the chain. A rethrown error that loses the original cause makes the real failure unfindable.
- [ ] Errors are distinguishable by type or code, not by matching message strings. Message matching breaks on the next wording change.

## Boundaries

- [ ] Every external call is wrapped: network, filesystem, subprocess, database, parsing untrusted input.
- [ ] Every external call has a timeout. Missing timeout is `High` — it turns a slow dependency into an outage.
- [ ] Retries exist where the failure is transient, are bounded, and back off. Retrying a non-idempotent operation is worse than failing.
- [ ] Non-transient failures are not retried. Retrying a 400 wastes time and hides the bug.

## Partial failure

- [ ] Multi-step operations state what happens when step 3 of 5 fails. Transaction, compensating action, or documented tolerance — pick one explicitly.
- [ ] Nothing is left half-written: no partial config, no orphaned rows, no half-copied directory.
- [ ] Operations that touch two systems have a reconciliation story. Cross-reference `Backend`.
- [ ] Batch operations report which items succeeded and which failed, rather than one aggregate boolean.

## Degradation

- [ ] Optional dependencies failing does not fail the whole operation. An analytics outage must not take down a request.
- [ ] There is a defined degraded mode where one exists — cached data, reduced functionality, a clear message.
- [ ] Degradation is visible. Silently serving stale data with no signal is how small outages become long ones.

## User-facing failure

- [ ] Every error the user can hit produces something actionable — what happened, and what to do.
- [ ] No stack trace, internal path, SQL, or provider error reaches the user. That is also an information-disclosure finding — cross-reference `Security`.
- [ ] Failures the user caused are distinguishable from failures the system caused.

## Recovery

- [ ] Restart-safety: the process can be killed at any point and restarted without corruption.
- [ ] Interrupted operations are resumable, or safely re-runnable from the start. Cross-reference the idempotency check in `functional.md`.
- [ ] Anything that can be left in a bad state has a way out — a repair command, a documented manual procedure, or self-healing.

## Severity guidance

| Situation | Severity |
|---|---|
| Swallowed error leading to silent data loss | Critical |
| Missing timeout on an external call | High |
| Multi-step write with no rollback or reconciliation | High |
| Retrying a non-idempotent operation | High |
| Internal error detail leaked to the user | Medium |
| Optional dependency failure taking down the request | Medium |
| Error type distinguished by message string | Medium |
| Silent degradation with no signal | Medium |
| Batch reporting only an aggregate result | Low |
