# Cost

What does running this bill? Gate: LLM/AI SDK calls, or metered cloud usage, was detected.

Cost defects are unusual: they do not break anything, so nothing surfaces them until an invoice does. The audit is mechanical — find every metered operation, then find what bounds it. Most checks below establish an absence — no bound, no cache, no attribution — which is `read` once the probe confirms the thing is genuinely missing. A cost finding that only speculates about volume with no probe run is `inferred`, and per the Evidence Contract that caps it at `Medium` regardless of how large the invoice could theoretically be.

The FinOps Foundation's Framework (2026 refresh, now scoped beyond cloud to AI/ML, SaaS, and licensing spend) names this same arc as three phases run as a loop, not a one-time project: Inform (visibility — inventory and attribution, below), Optimize (cut waste), Operate (the ongoing bounds that keep it from recurring). Useful vocabulary when reporting a finding back to a team that already runs FinOps.

## Inventory the meters

- [ ] Every operation that bills: `get_architecture` for the dependency manifest, then `search_code` the provider SDK imports — model calls, cloud services, payment SDKs, email/SMS providers. Build the meter list from what actually imports, not from what the project claims to use.
- [ ] For each one, the unit it bills on: `find_symbol`/read the client construction and call site to identify the billed dimension — tokens, requests, gigabytes, seconds, rows scanned.
- [ ] For each one, **what bounds it**: `search_code` near each call site for a limit, quota check, or cap (`maxTokens`, `limit`, `maxRetries`). If nothing is there, that is the finding regardless of current volume.
- [ ] Metered calls reachable by an unauthenticated caller: `trace_path` (or `find_callers`) from an unauthenticated route to the metered call. A path that exists here is `traced`, not `inferred` — that is someone else spending your money. Cross-reference `abuse.md`.

## Bounds

- [ ] Metered calls inside loops: `find_callees` on the loop body — a per-item model call over an unbounded list is the classic runaway.
- [ ] Input size bounded before a token-billed call, not after: read the call site's input construction for a truncation or size check before the payload is sent. Cross-reference `ai.md`.
- [ ] Output length capped: `search_code` for `max_tokens`/`maxOutputTokens` (or the SDK's equivalent) at each LLM call site. Missing, or set far above what the feature needs, bills for whatever the model decides to say.
- [ ] Retries bounded and backed off: `search_code` for a retry wrapper near each paid client call; read its config for max attempts and backoff. An unbounded retry against a failing paid endpoint bills for every attempt — this is both a cost and a reliability defect.
- [ ] Fan-out bounded: `find_callers` on each metered call to check whether it sits behind a loop over user-supplied input or a per-webhook handler — one user action must not trigger an unbounded number of paid calls.
- [ ] A hard ceiling exists somewhere, not only a notification: `search_code` for a rate limiter, spend cap, or circuit breaker that actually stops calls once a threshold is crossed, versus a budget alert that only notifies a human. A notify-only alert with nothing enforcing a stop is a weaker control than it looks — call that out distinctly from having neither, which is the stronger finding.

## Waste

- [ ] Repeated identical paid calls with no cache: `search_code` near each metered call site for a cache check preceding it, the same technique as the caching checks in `performance.md`. Here the missing cache costs money rather than latency.
- [ ] Cache in place but the key omits a dimension: `find_symbol` the cached call's signature, then read the key expression against every parameter that affects cost or output — a missing parameter means it never hits for varying inputs.
- [ ] The most expensive tier used for work a cheaper one handles: read the model/instance parameter at each call site (a literal model name, an instance size) and compare it against the task — a large model doing pure classification, a premium instance running a cron job.
- [ ] Paid calls whose results are discarded, made speculatively, or duplicated across code paths: `find_callers` on each metered call for a count greater than one with no shared cache between the call sites, or a returned value that is never assigned or used.
- [ ] Provisioned capacity far above observed use: read the IaC/deploy config for instance size or plan tier alongside any usage figure surfaced in code, config, or comments. This is usually `inferred` without a real usage number — say so. Cross-reference `infrastructure.md`.
- [ ] Storage with no retention policy: `search_code` for a TTL/retention/cleanup job on the bucket or table backing metered storage — it only grows, and it bills monthly forever. Cross-reference `privacy.md`, where retention is also a compliance question.
- [ ] Egress from chatty cross-region or cross-zone traffic: `search_code` for multi-region client construction or replication config paired with per-request (rather than batched) calls across that boundary.

## Development and test cost

- [ ] Tests do not hit paid endpoints: `search_code` test setup/fixtures for a mock or stub of each paid SDK (`jest.mock(`, a fake client); then check whether any `*.test.*` file still constructs the real client. A test suite that bills per run is a cost defect and a flake source.
- [ ] Development and staging have their own, smaller budgets: read the per-environment config (`.env.staging`, an environment-scoped IaC file) for instance size or quota values distinct from production.
- [ ] Nothing left running by default in non-production: `search_code` the deploy/IaC config for an auto-shutdown or scale-to-zero setting on non-production environments — its absence means idle instances bill exactly like busy ones.

## Attribution

- [ ] Spend is attributable to a feature, tenant, or endpoint: `search_code` for a cost-allocation tag, a billing label, or a tenant/feature identifier passed alongside each metered call — the dimensions that cover most real chargeback needs are team, project, environment (dev/staging/prod), model-or-resource-name, and cost-centre. Without attribution across at least some of these you can see the total and change nothing.
- [ ] Usage is recorded per operation where it bills per unit: `search_code` for a usage metric emitted alongside each metered call, the same probe technique as the coverage check in `observability.md`. Without it, a spike is undiagnosable.
- [ ] Someone would notice a 10× increase within a day: `search_code` for a budget alert or spend-threshold config (an IaC alert resource, a billing webhook handler). If the only detection mechanism found is the monthly invoice, that is the finding.

## Out of static reach

- The actual dollar amount billed — nothing here is checked against a real invoice.
- Real traffic volume through a metered path, and whether it is trending upward.
- Whether a cache or fallback actually hits at a meaningful rate in production.
- Whether a configured budget alert or quota has ever fired, versus merely being present.
- True cross-region egress volume and its cost.

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
| Budget alert is notify-only, nothing enforces a stop | Medium |
| Idle non-production resources left running | Low |
