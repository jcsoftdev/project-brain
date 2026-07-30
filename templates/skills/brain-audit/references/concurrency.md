# Concurrency

What happens when two of these run at once? Gate: a queue, worker, or background jobs were detected.

Concurrency defects are the ones that pass every test and fail in production, because tests run one thing at a time. Read for the interleaving, not the happy path.

## Shared mutable state

- [ ] Identify every piece of state reachable from more than one concurrent path. `find_callers` on each module-level mutable binding — more than one caller on different paths is a candidate.
- [ ] Module-level `let`, mutable singletons, and caches populated lazily. Lazy initialisation under concurrency initialises twice.
- [ ] Objects passed by reference to concurrent consumers and mutated by any of them.

## Read-modify-write

- [ ] Every read-then-write sequence on shared state. Between the read and the write, another actor can change it. Look for: counters, "check then create", "find or insert", version bumps, balance updates.
- [ ] The fix must be visible: an atomic operation, a compare-and-swap, a row lock, a unique constraint, or an explicit lock. A comment saying it is safe is not a mechanism.
- [ ] `check-then-act` on the filesystem — `existsSync` then `writeFile` is a race. Prefer atomic create or accept-and-handle-the-error.

## Ordering

- [ ] Nothing depends on the completion order of concurrent operations unless it is enforced.
- [ ] `Promise.all` over operations with hidden interdependencies — they will interleave.
- [ ] Fire-and-forget calls whose effects a later step assumes. `search_code` for unawaited async calls.
- [ ] Event handlers that can be re-entered before the previous invocation finishes.

## Locks and resources

- [ ] Locks are always released, including on the error path. A lock held through a throw is a permanent deadlock.
- [ ] Lock acquisition order is consistent everywhere; two paths taking A-then-B and B-then-A deadlock.
- [ ] Locks have a timeout or a lease, so a dead holder does not block forever.
- [ ] Nothing does I/O while holding a lock longer than necessary.

## Cancellation

- [ ] Long operations are cancellable, and cancellation actually stops work rather than only ignoring the result.
- [ ] Cancelled operations clean up — release resources, roll back partial state.
- [ ] A late result from a cancelled or superseded operation cannot overwrite a newer one. This is the same defect as the unmounted-component write in `frontend.md`.

## Signals and shutdown

- [ ] In-flight work completes or is safely abandoned on shutdown; nothing is left half-written.
- [ ] Shutdown is bounded — a hang on drain is worse than a forced exit.
- [ ] Persistent handles (database, WAL, file locks) are closed on every exit path.

## Reporting

State each finding as an interleaving: "if A reaches line X while B is between lines Y and Z, then …". A concurrency finding without a concrete interleaving is unfalsifiable, and reviewers correctly dismiss it.

## Severity guidance

| Situation | Severity |
|---|---|
| Read-modify-write on shared state with no atomicity | High |
| Lock not released on the error path | High |
| Inconsistent lock ordering across paths | High |
| Late result overwriting a newer one | Medium |
| Lazy initialisation racing to initialise twice | Medium |
| Unawaited async call whose effect is later assumed | Medium |
| Non-cancellable long operation | Medium |
| Unbounded shutdown drain | Low |
