# Concurrency

What happens when two of these run at once? Gate: a queue, worker, or background jobs were detected.

Concurrency defects are the ones that pass every test and fail in production, because tests run one thing at a time. Read for the interleaving, not the happy path.

## Shared mutable state

- [ ] Identify every piece of state reachable from more than one concurrent path. `find_callers` on each module-level mutable binding — more than one caller on different paths is a candidate. A shared resource with a timing window in which another concurrent sequence can modify it is the general race condition, not only an attacker-triggered one (MITRE, CWE-362, current, https://cwe.mitre.org/data/definitions/362.html).
- [ ] Module-level `let`, mutable singletons, and caches populated lazily: `search_code` for a module-scope `let`/static field, or a lazy-init guard (`if (!cache) cache = …`). Lazy initialisation under concurrency initialises twice — the second caller reads a half-built value or triggers the expensive setup a second time, because the reference-store and the field-initialising writes can be reordered with no further synchronisation (Pugh et al., Java Memory Model reference, University of Maryland, 2004, https://www.cs.umd.edu/~pugh/java/memoryModel/DoubleCheckedLocking.html). Rule out first: confirm the two call paths found via `find_callers` above can actually be in flight at the same time (same process, both reachable after startup) — mutually exclusive entry points (a CLI path vs. a server path) or a single-threaded startup phase are not racy even though two callers exist.
- [ ] Objects passed by reference to concurrent consumers and mutated by any of them: `find_callers` on the function that hands out the reference, then read each caller for an in-place mutation (`.push`, a property assignment) instead of a read-only use (MITRE, CWE-362, current, https://cwe.mitre.org/data/definitions/362.html).

## Read-modify-write

- [ ] Every read-then-write sequence on **in-process** shared state: `search_code` for `+= 1`/`++` on a stored field, or a `findOrCreate`/`getOrCreate` pattern operating on an in-memory or cache store. Between the read and the write, another actor can change it — the interfering sequence can be trusted, internal code, not only an attacker (MITRE, CWE-362, current, https://cwe.mitre.org/data/definitions/362.html). Look for: counters, "check then create", "find or insert", version bumps, balance updates. Row-level read-modify-write against the database — a `SELECT` immediately followed by an `INSERT`/`UPDATE` on the same row — is `database.md`'s check (`search_code` for the same pattern against a table row); cross-reference it there instead of re-reporting here.
- [ ] The fix must be visible at the site found above: Read it for an atomic operation, a compare-and-swap, a unique constraint, or an advisory/distributed lock. A comment saying it is safe is not a mechanism — if the site has none of these, it is the finding regardless of how it reads (MITRE, CWE-367, current, https://cwe.mitre.org/data/definitions/367.html — mitigations named are eliminating the check, minimising the gap when atomicity is impossible, locking before checking, or re-verifying after use).
- [ ] `check-then-act` on the filesystem: `search_code` for `existsSync(` followed by a nearby `writeFile`/`mkdirSync` — the check and the act are two operations, and anything can happen between them (MITRE, CWE-367 (TOCTOU), current, https://cwe.mitre.org/data/definitions/367.html). Prefer atomic create or accept-and-handle-the-error.

## Ordering

- [ ] `Promise.all` over operations with hidden interdependencies: `search_code` for `Promise.all(`, then read each operand for a dependency on another operand in the same array — they will interleave, not run in the order they are written; the resolved array is ordered by array position, "regardless of completion order" (MDN Web Docs, current, https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all).
- [ ] Fire-and-forget calls whose effects a later step assumes: `search_code` for an async call with no `await` and no `.then`/`.catch`, then `find_callers` on the caller's caller to check whether a subsequent step relies on the fired-off work having finished. An unhandled rejection on that call is "emitted whenever a Promise is rejected and no error handler is attached to the promise within a turn of the event loop" (Node.js project, official API docs, current, https://nodejs.org/api/process.html#event-unhandledrejection).
- [ ] For each fire-and-forget call found above, `search_code` for a `.catch(` on that same call or a process-level `process.on('unhandledRejection', ...)` handler, and `Read` the project's declared Node engine version (`package.json` `engines.node` or an `.nvmrc`/Dockerfile base image tag). Recent Node defaults raise an unhandled rejection as an uncaught exception (Node.js project, official API docs, current, https://nodejs.org/api/process.html#event-unhandledrejection): a fire-and-forget call with neither a local `.catch` nor a global handler does not just lose its own effect on Node.js 15+, it can take the whole process down on the next tick it rejects on. Refuted if a global `unhandledRejection` handler exists and does not itself call `process.exit`/rethrow — the process survives, and the finding reduces to the "lost effect" case above.
- [ ] Event handlers that can be re-entered before the previous invocation finishes: `search_code` for `.on(`/`addEventListener` registering an `async` callback, then read it for an in-flight guard (a boolean flag, a lock) before the next event can start processing.
- [ ] A queue message or job whose visibility/lease timeout can expire mid-processing, letting a second worker pick it up while the first is still running: `search_code` for a heartbeat/lease-extension call (SQS's `ChangeMessageVisibility`, a job-lock renewal) inside a handler whose runtime can exceed the queue's timeout — SQS's own default visibility timeout is 30 seconds, but rule out a longer configured value first: `search_code` the IaC/deploy config for the queue resource's own `VisibilityTimeout` setting, since a project can override the default to something already generous enough that this handler never approaches it (AWS, SQS Developer Guide, current, https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html). Its absence on a handler with real duration exceeding the configured timeout is the finding: two workers now hold the same logical message concurrently, and whatever the handler writes is a read-modify-write race between them.
- [ ] Where a heartbeat/lease-renewal call was found (the check above), `Read` the handler for whether its total possible runtime is bounded (a fixed batch size, a hard iteration cap) rather than open-ended (unbounded pagination, an external call with no timeout of its own). A renewal call proves the handler survives past the *configured* timeout, not past the queue's own hard ceiling — extending the timeout does not reset SQS's 12-hour limit from first receipt (AWS, SQS Developer Guide, current, https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html). Refuted if the handler is chunked into multiple messages/steps by design (e.g. re-enqueues its own continuation) rather than processing one unbounded unit of work under one lease.

## Locks and resources

- [ ] Locks are always released, including on the error path: `search_code` for the lock/mutex acquire call (`.lock(`, `acquireLock`, `withLock`), then Read whether the matching release sits in a `finally` block. A lock held through a throw is a permanent deadlock. This is the detailed elaboration of `backend.md`'s general acquired-resource-release check, scoped specifically to locks — cross-reference it rather than treating this as a separate finding.
- [ ] Lock acquisition order is consistent everywhere. Read every acquire site found above and list the resources each one locks, in order — two sites taking A-then-B and B-then-A deadlock, the same circular wait as the canonical two-thread, two-lock example (Oracle, Java Tutorials, current, https://docs.oracle.com/javase/tutorial/essential/concurrency/deadlock.html).
- [ ] Locks have a timeout or a lease: `search_code` the lock library's usage for a `timeout`/`ttl`/`lease` argument at each acquire site. Its absence means a dead holder blocks forever, and even a holder that merely pauses past its lease (e.g. a GC pause) can resume unaware the lease expired and act after a second client has already acquired the lock (Martin Kleppmann, 2016, https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html).
- [ ] Where a lock acquire site found above protects a write to a resource outside the process (a database row, an object store, a downstream API call), `search_code` the write call for a monotonically increasing token/version argument passed alongside it and `Read` the resource's own handler for a check that rejects a token lower than the last one it accepted. A lock with a timeout but no such fencing token at the point of use is not proven safe against a holder that resumes after its lease expired — it is a narrower, unproven case of the check above, since "a lease/timeout alone does not stop a paused holder from writing after expiry; only a fencing token enforced at the resource does" (Martin Kleppmann, 2016, https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html — Redlock in particular "does not have any facility for generating fencing tokens"). Refuted if the lock service itself guarantees the holder is fenced off before the lease expires (e.g. a consensus-backed lock that revokes the holder's session, not merely its own local timer) — cite the lock library's own documented guarantee before treating the timeout-only case as unsafe.
- [ ] Nothing does I/O while holding a lock longer than necessary: Read the code between each acquire and its release for a network or database call inside the critical section.

## Cancellation

- [ ] Long operations are cancellable, and cancellation actually stops work: `search_code` for `AbortController`/`AbortSignal`/a cancellation-token parameter on functions identified as long-running via `find_callees` (a loop or a chain of awaits). Its absence on an operation with real duration is the finding — `AbortController.abort()` is the documented mechanism to "abort an asynchronous operation before it has completed" (MDN Web Docs, current, https://developer.mozilla.org/en-US/docs/Web/API/AbortController).
- [ ] Cancelled operations clean up: Read the abort handler (`signal.addEventListener('abort', …)` or equivalent) for resource release or rollback — a cancellation that only stops listening, without releasing what it held, leaks. The signal documents only that the operation is notified, not that any resource it held is released (MDN Web Docs, current, https://developer.mozilla.org/en-US/docs/Web/API/AbortController) — that remains the responsibility of the code consuming the signal.
- [ ] A late result from a cancelled or superseded operation cannot overwrite a newer one: `search_code` for a stored "latest request id"/sequence number compared before a result is applied (`if (id !== latestId) return`). Its absence on a handler triggered by rapid repeated calls (search, autocomplete, a fast double-click) is the finding — the same defect as the unmounted-component write in `frontend.md`.

## Signals and shutdown

- [ ] In-flight work completes or is safely abandoned on shutdown: `search_code` for `process.on('SIGTERM'`/`'SIGINT'`, then read whether the handler awaits outstanding work before exiting — a pod's termination grace period defaults to 30 seconds before SIGKILL follows SIGTERM (Kubernetes project, official documentation, current, https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/).
- [ ] Shutdown is bounded: Read the shutdown handler for a forced-exit timeout wrapping the drain. Its absence means a hang on drain never resolves — worse than a forced exit, since nothing else will send SIGKILL once the orchestrator's own grace period has already elapsed (Kubernetes project, official documentation, current, https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/).
- [ ] Persistent handles are closed on every exit path: for each resource opened elsewhere (`find_symbol` the db pool, WAL, or file-lock construction), `search_code` the shutdown handler for a matching `.close()`/`.end()`/`.disconnect()` call.

## Reporting

State each finding as an interleaving: "if A reaches line X while B is between lines Y and Z, then …". A concurrency finding without a concrete interleaving is unfalsifiable, and reviewers correctly dismiss it.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number. Concurrency defects are mostly interleavings inside a single process or across backend workers, invisible to a browser walking one flow in one tab — the bundle reaches only the narrow slice that is user-triggerable through rapid repeated interaction in the UI itself.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl` (two requests from one action), `screenshots/` + `final-state.md` | A rapid double-click/double-submit on the same control fires two requests and produces a duplicated side effect. Refuted if the control was disabled after the first click before the second could register — check the disabled-state timestamp in `a11y-snapshot.md`/`steps.md` against the second click's timestamp. | Medium |
| `network.jsonl` (request/response timestamps out of order), `steps.md`/`final-state.md` | A fast repeated interaction (retype in a search/filter box) renders a stale result after a fresher one. Refuted if the rendered content matches the latest input despite out-of-order network arrival — a sequence guard is working even though the bundle alone can't see it in source. | Medium |

## Out of static reach

- Whether the interleaving described actually occurs under real load — thread/event-loop scheduling is not observable from source.
- Lock contention rate and wait time in production.
- Whether a race is merely possible or actually hit within any realistic time window.
- Actual behaviour of the runtime's scheduler or garbage collector during the interleaving.
- Whether a shutdown timeout value is long enough for real in-flight work to drain.
- Whether the machines involved in a lease-based lock have clocks close enough together for the lease window to mean what the code assumes — this module reads the timeout value, not the clock skew between the processes honoring it.
- Whether a resource guarded by a fencing token is only ever written through this codebase, or also reachable from a service or script this index does not cover — an unindexed writer bypasses the fencing check by definition.
- Whether this project's actual message broker redelivers on a timer the way the check's SQS-derived example assumes, or on a different trigger (consumer rebalance, explicit nack) — confirm the broker before applying the SQS-shaped fix.

## Severity guidance

| Situation | Severity |
|---|---|
| Read-modify-write on in-process or cache state with no atomicity | High |
| Lock not released on the error path | High |
| Inconsistent lock ordering across paths | High |
| Message/job redelivered on lease expiry while the original worker is still processing it | High |
| Distributed lock protecting a write with no fencing token at the resource | High |
| Fire-and-forget call with no local `.catch` or global handler on Node.js 15+ (unhandled rejection can crash the process) | High |
| Late result overwriting a newer one | Medium |
| Lazy initialisation racing to initialise twice | Medium |
| Unawaited async call whose effect is later assumed | Medium |
| Non-cancellable long operation | Medium |
| Heartbeat/lease renewal on a handler whose total runtime can exceed the queue's own hard ceiling | Medium |
| Unbounded shutdown drain | Low |
