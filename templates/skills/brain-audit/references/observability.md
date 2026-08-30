# Observability

Could you tell this broke, and find out why? Gate: logging, metrics, or tracing is present **or conspicuously absent**. This module was defined in the original audit design but no gate ever enabled it — it could never run. It runs now, and the absence case is the point.

The test is concrete: pick the three worst plausible failures for this system and ask, for each, what signal would exist. If the answer is "a user complains", that is the finding.

**This module fires on absence too, and absence is not an inconclusive probe.** A `search_code` for a logger, metrics client, or tracing SDK import that returns nothing is itself the evidence: the project has no observability, full stop. Report that once, at `High`, rather than working through every check below to individually confirm there is nothing to check.

## Coverage

- [ ] Every error path produces a signal: reuse the swallowed-error sites from `failure.md`'s `search_code` (empty catch blocks, `.catch(() => {})`) and check whether a log or metric call sits at each one. An empty catch block is both a failure defect and an observability hole.
- [ ] Every external call records outcome and duration: for each network/db/queue call site identified under `Performance`'s I/O checks, read whether it is wrapped with a timing measurement and a success/failure log or metric. These are the failures you do not control and most need to see.
- [ ] Background jobs, cron, and queue consumers report that they ran, what they processed, and what they skipped: reuse the consumer/scheduler entry points from `scalability.md`'s queue checks and read each for a start/end/summary log. Silent background work is invisible when it stops.
- [ ] Startup logs the resolved configuration: `search_code` the app's bootstrap/entry file for a log statement dumping resolved config, and confirm secret fields pass through a redaction/mask helper first. Without it, a misconfigured deploy is only diagnosable by reading the process environment directly.

## Log quality

- [ ] Structured, not interpolated prose: `search_code` for string concatenation or template literals inside log call arguments (`log("user " + id + " failed")`) versus a structured call taking an object. Interpolated prose cannot be queried; a structured field can.
- [ ] Levels are used meaningfully: `search_code` the ratio of `.warn(`/`.error(` calls to `.info(`/`.debug(` calls across the codebase. A ratio near zero on a system with real failure paths means the levels are decoration — everything is `info`.
- [ ] Correlation identifier flows through a whole operation, including into background work: `find_callees` from a request entry point into any async/queued work it triggers, and check whether `trace_id`/`span_id` (or an equivalent request-id) is threaded through, not dropped at the async boundary. Where a tracing SDK is present, `search_code` whether the logger call sites actually route through its log bridge/appender — a logger constructed independently of it silently drops trace/span correlation even though tracing exists elsewhere in the same service. Without correlation, a multi-service failure cannot be reassembled.
- [ ] Attribute and field names follow a shared convention, not a per-call-site dialect: `search_code` a sample of span/log/metric attribute keys against OpenTelemetry semantic conventions (semconv v1.44.0) namespaces — `http.request.method`, `db.system`, `db.query.text`, and similar. A codebase emitting `httpMethod`/`db_type` alongside a library's own `db.system` shows the instrumentation was hand-rolled per call site instead of following a shared schema, which is exactly what breaks correlation once a second service or a vendor tool joins on the field. Note: `gen_ai.*` (LLM) attributes are still Development-status in semconv as of 2026 — do not flag an AI call site for not yet matching a stable convention that does not exist.
- [ ] No personal data, credentials, or tokens in logs: `search_code` log call arguments for field names matching PII or secrets (email, password, token, ssn, authorization). Cross-reference `privacy.md` and `security.md` — this is where accidental egress usually happens.
- [ ] Volume is bounded: reuse the loop-detection technique from `performance.md` — `search_code` for a log call inside a loop body or a retry block with no sampling or aggregation.
- [ ] Enough context to act: read a sample of the log call sites found above for the fields actually passed — a bare `"failed"` with no identifier or input value is not actionable.

## Metrics

- [ ] The four that matter for any request-serving surface: `search_code` the metrics client import (statsd, Prometheus, OpenTelemetry metrics), then read which of rate, error rate, duration distribution, and saturation are actually emitted around the hot paths `repo_map` ranks highest. Averages hide the problem; percentiles do not.
- [ ] Queue depth and consumer lag wherever there is a queue: `search_code` near the queue-consumer code for a depth/lag metric. Cross-reference `scalability.md`.
- [ ] Business-level counters for the operations that matter, not only technical ones: `find_symbol` the handler for a core business event (signup, checkout, purchase) and check for an accompanying metric emission. "Signups dropped to zero" is caught by a business metric, not by CPU.
- [ ] Cardinality is bounded: read each metric-emission call site found above for a label built from a user id or a raw path — unbounded label values blow up the metrics backend's cardinality.

## Tracing

- [ ] Spans cover the boundaries: `search_code` the tracing SDK import and its span-creation calls, and check coverage of inbound request, outbound calls, database, and queue publish/consume.
- [ ] Context propagates across process boundaries, including asynchronous ones: `search_code` for a trace-context header (`traceparent`) or an explicit context-injection call at outbound HTTP and queue-publish sites.
- [ ] Span attributes carry the identifiers needed to correlate with logs: read a span-creation call for `setAttribute`/equivalent calls — a span with no identifiers cannot be joined back to the logs for the same operation.
- [ ] A sampling strategy is configured and stated, not silently defaulted: `search_code` the tracer/SDK init site for a sampler (`TraceIdRatioBased`, `ParentBased`, or a tail-sampling collector config). Most SDKs sample everything by default when unconfigured, which is a volume-and-cost problem before it is a correctness one — cross-reference `cost.md`. **Falsify before flagging**: a low-traffic internal service sampling everything is a reasonable choice, not a defect; anchor severity to traffic volume from `repo_map`/`find_callers`, not to the absence of a rate. If only head-based sampling is configured, that is not itself a finding — head sampling is the standard starting point — unless the project's own docs or alerting claim every error trace is captured, which head sampling alone cannot guarantee.

## Alerting

- [ ] Something alerts on the failures that matter, and it alerts on symptoms users feel rather than on causes: `search_code` the IaC/monitoring config for an alert rule tied to error rate or latency (a Datadog monitor, a Prometheus alert rule, a CloudWatch alarm).
- [ ] Every alert is actionable and has a stated response: read each alert rule found above for a runbook link or description field. An alert nobody acts on trains everyone to ignore alerts.
- [ ] Absence is alertable: for each background job/cron confirmed under Coverage, `search_code` for a heartbeat or dead-man's-switch check (a scheduled ping to a monitoring endpoint). A job that stops running produces no error on its own, so the check must be on the missing heartbeat.
- [ ] Health checks distinguish liveness from readiness, and readiness reflects real dependency health: `find_symbol` the liveness and readiness endpoints and read whether the readiness one checks a real dependency (a db ping, a queue connection) versus returning `200` unconditionally.
- [ ] Where an SLO or error-budget policy exists in the repo, alerting is burn-rate based, not a single static threshold: `search_code` for an SLO/error-budget config (an OpenSLO/Sloth/Nobl9 file, or a comment-documented target) and, if one exists, read whether the paired alert rule uses a multi-window burn-rate pattern (a fast window and a slow window) rather than one threshold. A single-window burn alert either pages too often on noise or too late on a slow leak. Absence of an SLO file entirely is not itself a finding — most repos never encode one — say `not applicable` rather than manufacturing the check.

## Out of static reach

- Whether an alert that fires actually reaches a human and gets acted on.
- Real log volume, and whether it exceeds retention or cost limits in practice.
- Whether anyone actually looks at the dashboards this module confirms exist.
- Actual on-call response time to a fired alert.
- Whether traces correlate correctly across async boundaries at runtime, versus merely having the propagation code in place.

## Severity guidance

| Situation | Severity |
|---|---|
| No signal at all for a plausible silent failure | High |
| Credentials or personal data written to logs | High |
| Background job with no success/failure signal | High |
| Error path with no log or metric | Medium |
| No correlation identifier across an operation | Medium |
| Unbounded log volume inside a loop or retry | Medium |
| Unbounded metric cardinality | Medium |
| Only averages, no percentiles | Low |
| Every message logged at one level | Low |
| Ad hoc/non-semconv attribute naming across span, log, or metric fields | Low |
| SLO/burn-rate config present but alert is single-window, not multi-window | Low |
