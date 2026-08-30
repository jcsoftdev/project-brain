# Concurrency

What happens when two of these run at once? Gate: a queue, worker, or background jobs were detected.

Concurrency defects are the ones that pass every test and fail in production, because tests run one thing at a time. Read for the interleaving, not the happy path.

## Shared mutable state

- [ ] Identify every piece of state reachable from more than one concurrent path. `find_callers` on each module-level mutable binding — more than one caller on different paths is a candidate.
- [ ] Module-level `let`, mutable singletons, and caches populated lazily: `search_code` for a module-scope `let`/static field, or a lazy-init guard (`if (!cache) cache = …`). Lazy initialisation under concurrency initialises twice — the second caller reads a half-built value or triggers the expensive setup a second time.
- [ ] Objects passed by reference to concurrent consumers and mutated by any of them: `find_callers` on the function that hands out the reference, then read each caller for an in-place mutation (`.push`, a property assignment) instead of a read-only use.

## Read-modify-write

- [ ] Every read-then-write sequence on shared state: `search_code` for `+= 1`/`++` on a stored field, `findOrCreate`, `getOrCreate`, or a `SELECT` immediately followed by an `INSERT`/`UPDATE` in the same function. Between the read and the write, another actor can change it. Look for: counters, "check then create", "find or insert", version bumps, balance updates.
- [ ] The fix must be visible at the site found above: read it for an atomic operation, a compare-and-swap, a row lock, or a unique constraint. A comment saying it is safe is not a mechanism — if the site has none of these, it is the finding regardless of how it reads.
- [ ] `check-then-act` on the filesystem: `search_code` for `existsSync(` followed by a nearby `writeFile`/`mkdirSync` — the check and the act are two operations, and anything can happen between them. Prefer atomic create or accept-and-handle-the-error.

## Ordering

- [ ] `Promise.all` over operations with hidden interdependencies: `search_code` for `Promise.all(`, then read each operand for a dependency on another operand in the same array — they will interleave, not run in the order they are written.
- [ ] Fire-and-forget calls whose effects a later step assumes: `search_code` for an async call with no `await` and no `.then`/`.catch`, then `find_callers` on the caller's caller to check whether a subsequent step relies on the fired-off work having finished.
- [ ] Event handlers that can be re-entered before the previous invocation finishes: `search_code` for `.on(`/`addEventListener` registering an `async` callback, then read it for an in-flight guard (a boolean flag, a lock) before the next event can start processing.
- [ ] A queue message or job whose visibility/lease timeout can expire mid-processing, letting a second worker pick it up while the first is still running: `search_code` for a heartbeat/lease-extension call (SQS's `ChangeMessageVisibility`, a job-lock renewal) inside a handler whose runtime can exceed the queue's timeout — SQS's own default visibility timeout is 30 seconds. Its absence on a handler with real duration is the finding: two workers now hold the same logical message concurrently, and whatever the handler writes is a read-modify-write race between them.

## Locks and resources

- [ ] Locks are always released, including on the error path: `search_code` for the lock/mutex acquire call (`.lock(`, `acquireLock`, `withLock`), then read whether the matching release sits in a `finally` block. A lock held through a throw is a permanent deadlock.
- [ ] Lock acquisition order is consistent everywhere: collect every acquire site found above and list the resources each one locks, in order — two sites taking A-then-B and B-then-A deadlock.
- [ ] Locks have a timeout or a lease: `search_code` the lock library's usage for a `timeout`/`ttl`/`lease` argument at each acquire site. Its absence means a dead holder blocks forever.
- [ ] Nothing does I/O while holding a lock longer than necessary: read the code between each acquire and its release for a network or database call inside the critical section.

## Cancellation

- [ ] Long operations are cancellable, and cancellation actually stops work: `search_code` for `AbortController`/`AbortSignal`/a cancellation-token parameter on functions identified as long-running via `find_callees` (a loop or a chain of awaits). Its absence on an operation with real duration is the finding.
- [ ] Cancelled operations clean up: read the abort handler (`signal.addEventListener('abort', …)` or equivalent) for resource release or rollback — a cancellation that only stops listening, without releasing what it held, leaks.
- [ ] A late result from a cancelled or superseded operation cannot overwrite a newer one: `search_code` for a stored "latest request id"/sequence number compared before a result is applied (`if (id !== latestId) return`). Its absence on a handler triggered by rapid repeated calls (search, autocomplete, a fast double-click) is the finding — the same defect as the unmounted-component write in `frontend.md`.

## Signals and shutdown

- [ ] In-flight work completes or is safely abandoned on shutdown: `search_code` for `process.on('SIGTERM'`/`'SIGINT'`, then read whether the handler awaits outstanding work before exiting.
- [ ] Shutdown is bounded: read the shutdown handler for a forced-exit timeout wrapping the drain. Its absence means a hang on drain never resolves — worse than a forced exit.
- [ ] Persistent handles are closed on every exit path: for each resource opened elsewhere (`find_symbol` the db pool, WAL, or file-lock construction), `search_code` the shutdown handler for a matching `.close()`/`.end()`/`.disconnect()` call.

## Reporting

State each finding as an interleaving: "if A reaches line X while B is between lines Y and Z, then …". A concurrency finding without a concrete interleaving is unfalsifiable, and reviewers correctly dismiss it.

## Out of static reach

- Whether the interleaving described actually occurs under real load — thread/event-loop scheduling is not observable from source.
- Lock contention rate and wait time in production.
- Whether a race is merely possible or actually hit within any realistic time window.
- Actual behaviour of the runtime's scheduler or garbage collector during the interleaving.
- Whether a shutdown timeout value is long enough for real in-flight work to drain.

## Severity guidance

| Situation | Severity |
|---|---|
| Read-modify-write on shared state with no atomicity | High |
| Lock not released on the error path | High |
| Inconsistent lock ordering across paths | High |
| Message/job redelivered on lease expiry while the original worker is still processing it | High |
| Late result overwriting a newer one | Medium |
| Lazy initialisation racing to initialise twice | Medium |
| Unawaited async call whose effect is later assumed | Medium |
| Non-cancellable long operation | Medium |
| Unbounded shutdown drain | Low |
