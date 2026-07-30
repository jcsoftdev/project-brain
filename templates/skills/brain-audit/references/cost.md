# Cost

What does running this bill? Gate: LLM/AI SDK calls, or metered cloud usage, was detected.

Cost defects are unusual: they do not break anything, so nothing surfaces them until an invoice does. The audit is mechanical — find every metered operation, then find what bounds it.

## Inventory the meters

- [ ] Every operation that bills: model calls, per-request cloud services, egress, storage, function invocations, third-party API calls.
- [ ] For each one, the unit it bills on — tokens, requests, gigabytes, seconds, rows scanned.
- [ ] For each one, **what bounds it**. If the answer is "nothing", that is the finding regardless of current volume.
- [ ] Metered calls reachable by an unauthenticated caller. Cross-reference `abuse.md` — that is someone else spending your money.

## Bounds

- [ ] Metered calls inside loops. `find_callees` on the loop body — a per-item model call over an unbounded list is the classic runaway.
- [ ] Input size bounded before a token-billed call, not after. Cross-reference `ai.md`.
- [ ] Output length capped. An unbounded max-tokens setting bills for whatever the model decides to say.
- [ ] Retries bounded and backed off. An unbounded retry against a failing paid endpoint bills for every attempt — this is both a cost and a reliability defect.
- [ ] Fan-out bounded: one user action must not trigger an unbounded number of paid calls.
- [ ] A hard ceiling exists somewhere — quota, budget alert, circuit breaker. Something that stops the bleeding without a human.

## Waste

- [ ] Repeated identical paid calls with no cache. Cross-reference the caching checks in `performance.md`; here the missing cache costs money rather than latency.
- [ ] Cache in place but the key omits a dimension, so it never hits.
- [ ] The most expensive tier used for work a cheaper one handles — a large model for classification, a premium instance for a cron job.
- [ ] Paid calls whose results are discarded, made speculatively, or duplicated across code paths.
- [ ] Provisioned capacity far above observed use. Cross-reference `infrastructure.md`.
- [ ] Storage with no retention policy — it only grows, and it bills monthly forever. Cross-reference `privacy.md`, where retention is also a compliance question.
- [ ] Egress from chatty cross-region or cross-zone traffic.

## Development and test cost

- [ ] Tests do not hit paid endpoints. A test suite that bills per run is a cost defect and a flake source. Verify the fakes are actually used.
- [ ] Development and staging have their own, smaller budgets and cannot reach production-scale resources.
- [ ] Nothing left running by default in non-production — idle instances bill exactly like busy ones.

## Attribution

- [ ] Spend is attributable to a feature, tenant, or endpoint. Without attribution you can see the total and change nothing.
- [ ] Usage is recorded per operation where it bills per unit, so a spike is diagnosable. Cross-reference `observability.md`.
- [ ] Someone would notice a 10× increase within a day. If the only detection is the monthly invoice, that is the finding.

## Severity guidance

| Situation | Severity |
|---|---|
| Unauthenticated caller can trigger a metered operation | Critical |
| Unbounded retry against a paid endpoint | High |
| Metered call inside an unbounded loop | High |
| No ceiling, quota, or budget alert anywhere | High |
| Tests hitting paid endpoints | High |
| Unbounded input or output size on a per-token call | High |
| Repeated identical paid calls with no cache | Medium |
| Cache key missing a dimension, so it never hits | Medium |
| Storage with no retention policy | Medium |
| Expensive tier used for work a cheaper one handles | Medium |
| No spend attribution per feature or tenant | Medium |
| Idle non-production resources left running | Low |
