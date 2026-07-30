# Scalability

What breaks when there is more of everything? Gate: a queue, worker, or background jobs were detected.

`Performance` asks how fast one operation is. This module asks what happens at ten times the load, ten times the data, and two instances instead of one.

## Horizontal readiness

- [ ] No state lives only in one process's memory. In-memory caches, counters, session maps, and rate-limit buckets all diverge across instances.
- [ ] Nothing depends on being the only instance. `search_code` for in-process locks, singletons holding mutable state, and interval timers — each one runs N times with N instances.
- [ ] Scheduled work has a leader election or a distributed lock. Otherwise every instance runs the cron.
- [ ] Local filesystem writes are either ephemeral or explicitly shared storage. A file written on one instance and read on another silently fails behind a load balancer.

## Queues and workers

- [ ] Every queue has a consumer, and every consumer has a producer. Cross-reference the half-wired pairs table in `flow-integrity.md` — an unconsumed queue grows forever.
- [ ] Jobs are idempotent. At-least-once delivery is the norm, so a job that runs twice must be safe.
- [ ] Failed jobs go somewhere — a dead-letter queue, a retry with backoff, or an alert. Silent drop is the default failure mode and it is `High`.
- [ ] Retries are bounded. An infinite retry on a poison message blocks the queue.
- [ ] Job payloads carry identifiers, not whole objects. Fat payloads make the queue the database.
- [ ] Concurrency per consumer is bounded and configurable.

## Data growth

- [ ] Every table, collection, log, and index has an answer to "what bounds this?" Unbounded growth with no retention policy is a finding even when it is slow.
- [ ] Queries that work today at current row counts — state the count at which each becomes a problem.
- [ ] Batch jobs that process everything rather than only what changed. These get slower every day by construction.
- [ ] Pagination is cursor-based where the dataset is large; offset pagination degrades linearly.

## Backpressure

- [ ] Producers slow down or shed load when consumers fall behind. Unbounded buffering between them just moves the failure.
- [ ] Bounded pools exist for connections, workers, and concurrent outbound calls.
- [ ] Rate limits protect downstream dependencies, not only inbound callers.
- [ ] Timeouts are shorter than the caller's timeout, so failures surface at the right layer.

## Degradation

- [ ] Under load the system degrades rather than collapsing — sheds optional work, serves stale cache, returns a clear 503.
- [ ] Non-critical work is genuinely non-blocking. A failing analytics call must not fail the request.
- [ ] Health checks reflect real capacity, not just process liveness.

## Severity guidance

| Situation | Severity |
|---|---|
| Failed jobs silently dropped | High |
| In-memory state that breaks with a second instance | High |
| Unbounded retry on a poison message | High |
| Scheduled job with no leader election | High |
| Non-idempotent job under at-least-once delivery | High |
| No backpressure between producer and consumer | Medium |
| Unbounded data growth with no retention policy | Medium |
| Batch job that reprocesses everything | Medium |
| Offset pagination over a large dataset | Low |
