# Scalability

What breaks when there is more of everything? Gate: a queue, worker, or background jobs were detected.

`Performance` asks how fast one operation is. This module asks what happens at ten times the load, ten times the data, and two instances instead of one. Most checks below are `read` once you find the file and `inferred` on the actual future volume — state which.

## Horizontal readiness

- [ ] No state lives only in one process's memory: `search_code` for a module-level `Map`/`Set`/object literal used as a cache, counter, or session store, then `find_callers` to confirm it is written on the request path rather than populated once from static config.
- [ ] Nothing depends on being the only instance: `search_code` for in-process locks, singletons holding mutable state, and interval timers — each one runs N times with N instances.
- [ ] Scheduled work has a leader election or a distributed lock: `search_code` for `setInterval`/a cron import/a scheduler registration, then read the surrounding code for a lock/leader check (`SETNX`, an advisory lock, an "only run on leader" guard). Rule out a genuinely single-replica deployment — read the deploy manifest or Dockerfile replica count — before flagging.
- [ ] Local filesystem writes are either ephemeral or explicit shared storage: `search_code` for `fs.writeFile`/`createWriteStream` and check the target path against a shared-storage prefix (S3, a mounted volume) versus a local `/tmp`-style path. A file written on one instance and read on another silently fails behind a load balancer.

## Queues and workers

- [ ] Every queue has a consumer, and every consumer has a producer: `search_code` the queue/topic name literal and confirm it appears at both a publish call (`.publish`/`.send`/`.enqueue`) and a consume call (`.consume`/`on('message'`). Cross-reference the half-wired pairs table in `flow-integrity.md` — an unconsumed queue grows forever.
- [ ] Jobs are idempotent: `find_symbol` the job handler and read its write path. An `INSERT` with no unique constraint or dedup key, run under at-least-once delivery, double-writes on redelivery. Rule out that the transport itself guarantees exactly-once (name it) before flagging — but check the guarantee's actual scope first: Kafka's exactly-once semantics (idempotent producer + transactions) covers Kafka-to-Kafka only — offsets, state stores, output topics — not a database write or HTTP call the handler makes as a side effect; SQS FIFO's deduplication is a 5-minute window on the *send* path (`MessageDeduplicationId` or a content hash), not a guarantee the handler itself won't run twice after redelivery; RabbitMQ makes no exactly-once claim at all — its own docs say to make consumers idempotent. A rule-out that doesn't name which of these applies, and confirm the side effect stays inside that boundary, is not a rule-out.
- [ ] Failed jobs go somewhere: `search_code` for the queue library's failure hook (`on('failed'`, a dead-letter binding, a `.catch(` around job processing). Silent drop is the default failure mode in most libraries and it is `High`.
- [ ] The dead-letter destination is actually drained by something: `search_code` for a redrive/replay path (SQS's `StartMessageMoveTask`, a scheduled job reading the DLQ, an alert wired to DLQ depth) versus a DLQ that exists only as a naming convention. Replay tooling varies by platform — SQS supports redrive natively; Kafka Connect's dead-letter topic (sink connectors only — source connectors have no DLQ mechanism at all) is a plain topic with no built-in replay; Azure Service Bus has no built-in redrive either. A DLQ nothing reads is a slower version of silent drop.
- [ ] Retries are bounded: `search_code` for the retry/backoff config (`attempts:`, `backoff:`, `maxRetries`) on the job/queue definition. Read the library's default when no config is present — several default to infinite.
- [ ] Job payloads carry identifiers, not whole objects: read a handful of `.enqueue`/`.publish` call sites — a full domain object in the payload instead of an id is the finding. Fat payloads make the queue the database.
- [ ] Concurrency per consumer is bounded and configurable: `search_code` for the consumer's concurrency/prefetch setting; its absence means the library's own default applies, which is worth stating explicitly.

## Data growth

- [ ] Every table, collection, log, and index has an answer to "what bounds this?": `search_code` for a retention/TTL/cleanup job referencing each table name. Report the ones with no hit once, as a single finding with the full list — not one finding per table.
- [ ] Queries that work today at current row counts: read the query (`find_symbol`/`expand_context`) and state the row count at which an unindexed filter or full scan degrades. This is `inferred` without a real count from the schema or a migration comment — cap it at `Medium` accordingly.
- [ ] Batch jobs that process everything rather than only what changed: `search_code` the batch job's query for a narrowing clause (`WHERE updated_at >`, `WHERE processed = false`) versus an unfiltered `.findAll()`/`SELECT *`. A job that reprocesses the whole table gets slower every day by construction.
- [ ] Pagination is cursor-based where the dataset is large: `search_code` the listing route/query for `OFFSET`/`.skip(` versus a cursor or keyset parameter (`after:`, `WHERE id >`). Offset pagination degrades linearly as the table grows.

## Backpressure

- [ ] Producers slow down or shed load when consumers fall behind: `search_code` for a queue-depth check, an ack wait, or a `pause()`/`resume()` hook (Node stream `highWaterMark`, a Kafka consumer's `pause()`) before the next publish. The absence signature is concrete: unbounded array/queue growth with no size cap, a fan-out that spawns one promise or goroutine per item with no semaphore or worker-pool limit, or a publish loop with no await/ack-wait between sends. Unbounded fire-and-forget publishing just moves the failure downstream.
- [ ] A reactive/streaming operator that claims to handle backpressure is actually bounded: `search_code` for the operator call and check whether a capacity argument is present — Project Reactor's `onBackpressureBuffer()` is unbounded by default unless given an explicit max size. An unconfigured "backpressure-handling" operator can still exhaust memory under sustained overload.
- [ ] Bounded pools exist for connections, workers, and concurrent outbound calls: `search_code` for the pool config (`maxConnections`, `pool: { max: }`, an HTTP agent's `maxSockets`). Its absence means the client library's own unbounded default applies. This is the bulkhead pattern — a slow or saturated dependency should exhaust only its own pool, not one shared with every other dependency; a single HTTP client or connection pool reused across multiple downstream services is the common way this fails. Cross-reference `Failure`'s circuit-breaker check — the two patterns are usually paired.
- [ ] Rate limits protect downstream dependencies, not only inbound callers: `search_code` for a throttle wrapper around outbound calls to a third-party dependency, separate from the inbound API gate.
- [ ] Timeouts are shorter than the caller's timeout, so failures surface at the right layer: read the timeout set on each outbound client (`find_symbol`/read the client construction) and compare it against the framework's own request timeout.

## Degradation

- [ ] Under load the system degrades rather than collapsing: read the failure path of the top-ranked handler from `repo_map` for a stale-cache fallback or an explicit `503`, versus an unhandled exception that takes the whole request down.
- [ ] Non-critical work is genuinely non-blocking: `search_code` for an `await` on an analytics/telemetry call inside a request handler with no surrounding try/catch or fire-and-forget wrapper — a failing optional call must not fail the request.
- [ ] Health checks reflect real capacity, not just process liveness: `find_symbol` the health-check handler and read it — a handler that returns `200` unconditionally is a liveness check wearing a readiness check's name.

## Out of static reach

- Actual behaviour under N concurrent instances — nothing here is run.
- Whether observed traffic ever approaches the stated bound, or the crossover row count named above.
- True queue throughput versus producer rate under real load.
- Real failover or leader-election behaviour during an actual node loss.
- Whether a rate limit or bounded pool is sized correctly for real downstream capacity, versus merely present.

## Severity guidance

| Situation | Severity |
|---|---|
| Failed jobs silently dropped | High |
| In-memory state that breaks with a second instance | High |
| Unbounded retry on a poison message | High |
| Scheduled job with no leader election | High |
| Non-idempotent job under at-least-once delivery | High |
| Exactly-once guarantee assumed for a side effect outside the transport's actual transactional boundary | High |
| No backpressure between producer and consumer | Medium |
| Unbounded data growth with no retention policy | Medium |
| Batch job that reprocesses everything | Medium |
| Dead-letter queue with no redrive or replay path — failures accumulate unread | Medium |
| Reactive backpressure operator used with no bounded capacity (default-unbounded buffer) | Medium |
| Offset pagination over a large dataset | Low |
