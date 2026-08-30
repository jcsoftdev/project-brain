# Idempotency

Is repetition safe? Gate: retries, webhooks, queues, or externally-triggered writes present.

`functional.md` checks whether an operation the code or docs *advertise* as idempotent actually is, once. `concurrency.md` owns interleavings between simultaneous actors. This module owns the narrower mechanical question underneath both: what actually makes a repeated call safe — a key, a constraint, a check — and whether every retryable path has one. A finding about two requests racing belongs in `concurrency.md`; a finding about the same request arriving twice belongs here.

## Reachable retry surface

- [ ] Every write reachable from a retryable entry point — `trace_path` from each retry helper, queue consumer, or webhook route to the write(s) it performs. A retry wrapper that only retries a read is not a finding here; one that retries a write is the starting point for everything below.
- [ ] For each such write: does an idempotency key exist on the request, and where does it come from? A client-generated key survives a client-side retry (the client resends the same key); a server-generated key does not — the server assigns a new one on retry and the write happens again. `find_symbol` the key generation to see which side owns it. There is no ratified standard to check this against — `draft-ietf-httpapi-idempotency-key-header` expired 2026-04-18 with no successor draft — so judge it against the convention Stripe and AWS both implement (client-generated), not a spec.
- [ ] The key is enforced by a uniqueness constraint (DB unique index, `INSERT ... ON CONFLICT`, a dedupe table with a unique key) rather than only a read-then-write existence check. A "look up by key, if not found insert" without a constraint is itself a race — cross-reference `concurrency.md` for the read-modify-write pattern, but report the missing-constraint instance here since the *mechanism* is this module's concern.
- [ ] A key reused with a *different* request body is rejected, not silently replayed or silently reprocessed — `search_code` the key-lookup site for a stored-payload comparison (a hash or field-by-field check) before treating the request as a duplicate. Stripe and AWS both make this a hard error (AWS EC2's `IdempotentParameterMismatch`); a handler that only keys on the identifier and ignores the body lets a retried-with-different-arguments call silently do the wrong thing.
- [ ] A duplicate key with the *same* payload replays the original stored response rather than recomputing a fresh one — read the key-hit branch for a stored-response return versus falling through to re-execute business logic. Recomputing breaks the caller's assumption that a retry is a no-op if downstream state moved between the two attempts (a price, an inventory count).
- [ ] The idempotency key's scope — is it unique per operation type and per actor, or global? A key that is unique only by value (not scoped to the endpoint or the account) lets one caller's retry key collide with an unrelated operation from another caller, silently short-circuiting a legitimate second write as a "duplicate."

## Webhooks

- [ ] Signature verification present on every webhook route before the payload is trusted — `search_code` the webhook handler for a signature/HMAC check (Stripe's `Stripe-Signature`, HMAC-SHA256 over `timestamp.payload`; GitHub's `X-Hub-Signature-256`; or the cross-vendor Standard Webhooks spec — `webhook-signature`/`svix-signature`, HMAC-SHA256 over `msg_id.timestamp.payload`, now adopted by 40+ providers including OpenAI, Anthropic, and Twilio). Its absence means anyone who finds the URL can trigger the write, not just a genuine retry.
- [ ] The comparison is constant-time, not `==`/`===`/string equality — `search_code` for the signature-compare line and confirm it calls a constant-time primitive (`crypto.timingSafeEqual` in Node, `hmac.compare_digest` in Python, `hash_equals` in PHP, `Rack::Utils.secure_compare` in Ruby). GitHub's and Stripe's own docs both call out plain `==` explicitly: it short-circuits on the first mismatched byte and leaks the correct prefix through response timing.
- [ ] The signature is computed over the raw request body, not a re-serialised copy — `search_code` for a body-parsing middleware (Express's `express.json()` mounted globally is the canonical case) that runs before the webhook route and reparses the payload. Re-serialising JSON changes key order, whitespace, and number formatting, which changes the bytes the HMAC covers and breaks verification — the raw body must be captured before any parsing, scoped to the webhook route specifically.
- [ ] A replay window — is a signed-but-stale payload (timestamp far in the past) still accepted? Stripe's default tolerance is 5 minutes, and its own docs warn against setting tolerance to 0 (that disables the check entirely). Without a window, a captured valid payload can be replayed indefinitely.
- [ ] The provider's event ID is stored and checked before processing, not just the payload's business data — `find_callees` from the handler to confirm a lookup against previously-seen event IDs happens before the side-effecting write, not after.
- [ ] Fields inside the payload (an `event_type`, a `customer_id`) are not used to route or act on the request before the signature is verified — verification must gate every use of the body, not just the parts a developer remembered to protect.
- [ ] Out-of-order delivery: a handler that assumes events arrive in the order they were sent (e.g. `payment.created` before `payment.refunded`) — most providers guarantee at-least-once, not ordered, delivery. `search_code` for sequencing assumptions (a state transition that would break if the "later" event arrived first).
- [ ] Duplicate webhook deliveries from provider-side retries (the provider itself retries on a non-2xx or a timeout) versus the handler's own idempotency check — confirm the handler returns success only after the write is durably committed, not before, or the provider will interpret a slow success as a failure and retry a request that already landed.

## Queue and retry semantics

- [ ] At-least-once delivery acknowledged in the consumer's code (idempotency key, or the write itself is naturally idempotent — e.g. a `SET`, not an `INCREMENT`) versus silently assumed to be exactly-once. `search_code` the consumer's ack/commit point relative to where the write happens, concretely: Kafka's `enable.auto.commit` defaults to `true` on a 5-second interval and commits the offset once `poll()` returns — before the handler body has run — so a crash mid-processing is silent loss unless the commit is manual and placed after the write; SQS deletes the message explicitly, and a delete issued before processing has the same effect, while a delete issued after processing but with too short a visibility timeout (SQS's default is 30 seconds) causes duplicate redelivery instead of loss; RabbitMQ's manual ack before processing is discarded on crash, ack after is safe by default (auto-requeue on channel/connection close) provided the write itself is idempotent. An ack after a failed write, or a write before the ack, both reopen the redelivery case.
- [ ] Consumer-side dedupe is implemented as an inbox / idempotent-consumer table (a `processed_message(id)` record inserted in the same transaction as the handling), not just an in-memory guard — `search_code` for a processed-messages/seen-ids table and confirm the insert and the business write share a transaction. An in-memory-only guard resets on every deploy and duplicates on every restart.
- [ ] Retries that are unbounded (no max attempt count) or unjittered (fixed-interval retry against a struggling downstream, amplifying the load that caused the failure in the first place). Named jitter strategies exist for a reason — Full Jitter (`random(0, min(cap, base*2^attempt))`) is the primary-source recommendation over Equal Jitter or no jitter at all, since it does the least total work against a recovering backend for comparable completion time (AWS Architecture Blog, "Exponential Backoff and Jitter").
- [ ] A retry wrapper applied to an operation that is not idempotent by construction — `find_callers` on the retry helper and check each wrapped call against the checks above; wrapping a bare `INSERT` with no key is a retry mechanism actively making things worse.
- [ ] Retry-on-timeout specifically: a timeout means the first attempt's outcome is unknown, not that it failed. `search_code` for a catch-and-retry around a timeout error with no idempotency key — this is the mechanism behind duplicate charges and duplicate emails, because the first attempt may have already succeeded server-side.
- [ ] A poison message (one that will never succeed, e.g. malformed payload) has a dead-letter path rather than being retried indefinitely — `find_callees` from the consumer's error handler to confirm a max-attempts-then-park path exists, distinct from a message that fails only transiently.

## Client-side half

- [ ] A submit action (payment, form post, "create") whose button is not disabled after the first click, and no client-side dedupe (request-in-flight guard, disabled state, single-flight promise) — `search_code` the submit handler for a guard. Cross-reference `flow-integrity.md`, which owns the broader UI-flow-correctness question; report the specific double-submit-with-no-guard instance here since the mechanism is a missing idempotency key on the client side of the same problem.

## Compensation and cleanup

- [ ] Multi-step operations that can fail partway (charge then provision, reserve then confirm) have a compensating action for the already-completed steps — `find_callees` from the orchestrating function to see if a rollback/compensate path exists for each step, not just a try/catch that logs and gives up.
- [ ] A partial failure leaves state that is reversible by a human or a retry, rather than requiring manual database surgery — read the error path to confirm which state the record is left in.
- [ ] Dedupe/idempotency-key records are stored but never expired — `search_code` for the dedupe table's write path and check for a corresponding TTL or cleanup job. An unbounded dedupe store is a slow leak, and once it is large enough that lookups degrade, the protection it provides degrades with it.

## Out of static reach

- Actual delivery ordering and duplication behaviour of the specific queue/webhook provider in production.
- Whether a race window is wide enough to matter at real traffic volumes.
- Whether a compensating action is triggered promptly enough in practice, versus existing in code but rarely exercised.
- Idempotency-key storage capacity under sustained load.

## Severity guidance

| Situation | Severity |
|---|---|
| Retryable write with no idempotency key and no unique constraint | Critical |
| Webhook route with no signature verification | Critical |
| Retry-on-timeout wrapping a non-idempotent write (duplicate charge shape) | High |
| Idempotency key server-generated instead of client-supplied on a client-retried path | High |
| Idempotency enforced only by read-then-write check, no DB constraint | High |
| Multi-step operation with no compensating action on partial failure | High |
| Idempotency key reused with a different request body is silently accepted, not rejected | High |
| Consumer dedupe implemented only as an in-memory guard, not a durable inbox record | High |
| Signature verified over a re-serialised body instead of the raw bytes | High |
| Payload fields trusted or routed on before signature verification | High |
| Webhook handler with no replay-window check | Medium |
| Consumer assumes ordered delivery from an at-least-once queue | Medium |
| Unbounded or unjittered retry against a downstream dependency | Medium |
| Idempotency key not scoped per operation/actor, allowing cross-operation collision | Medium |
| Handler acknowledges before the write is durably committed | Medium |
| Poison message retried indefinitely with no dead-letter path | Medium |
| Submit action with no client-side dedupe guard | Medium |
| Duplicate key + same payload recomputes a fresh response instead of replaying the stored one | Medium |
| Signature compared with non-constant-time equality | Medium |
| Dedupe/idempotency records stored with no expiry | Low |
