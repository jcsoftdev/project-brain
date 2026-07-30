# Observability

Could you tell this broke, and find out why? Gate: logging, metrics, or tracing is present **or conspicuously absent**. This module was defined in the original audit design but no gate ever enabled it — it could never run. It runs now, and the absence case is the point.

The test is concrete: pick the three worst plausible failures for this system and ask, for each, what signal would exist. If the answer is "a user complains", that is the finding.

## Coverage

- [ ] Every error path produces a signal. Cross-reference the swallowed-error sweep in `failure.md` — an empty catch block is both a failure defect and an observability hole.
- [ ] Every external call records outcome and duration. These are the failures you do not control and most need to see.
- [ ] Background jobs, cron, and queue consumers report that they ran, what they processed, and what they skipped. Silent background work is invisible when it stops.
- [ ] Startup logs the resolved configuration — with secrets redacted — so a misconfigured deploy is diagnosable from the first line.

## Log quality

- [ ] Structured, not interpolated prose. `log("user " + id + " failed")` cannot be queried; a structured field can.
- [ ] Levels are used meaningfully: `error` means someone should look, `warn` means it is degraded, `info` is the narrative. If everything is `info`, the levels are decoration.
- [ ] Correlation identifier flows through a whole operation, including into background work. Without it, a multi-service failure cannot be reassembled.
- [ ] No personal data, credentials, or tokens in logs — cross-reference `privacy.md` and `security.md`. This is where accidental egress usually happens.
- [ ] Volume is bounded: nothing logs per item in a large loop, and no message repeats per retry without a limit.
- [ ] Enough context to act — identifiers and inputs, not just "failed".

## Metrics

- [ ] The four that matter for any request-serving surface: rate, error rate, duration distribution, saturation. Averages hide the problem; percentiles do not.
- [ ] Queue depth and consumer lag wherever there is a queue — cross-reference `scalability.md`.
- [ ] Business-level counters for the operations that matter, not only technical ones. "Signups dropped to zero" is caught by a business metric, not by CPU.
- [ ] Cardinality is bounded — no metric labelled with a user id or a raw path.

## Tracing

- [ ] Spans cover the boundaries: inbound request, outbound calls, database, queue publish and consume.
- [ ] Context propagates across process boundaries, including asynchronous ones.
- [ ] Span attributes carry the identifiers needed to correlate with logs.

## Alerting

- [ ] Something alerts on the failures that matter, and it alerts on symptoms users feel rather than on causes.
- [ ] Every alert is actionable and has a stated response. An alert nobody acts on trains everyone to ignore alerts.
- [ ] Absence is alertable: a job that stops running produces no error, so the check must be on the missing heartbeat.
- [ ] Health checks distinguish liveness from readiness, and readiness reflects real dependency health.

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
