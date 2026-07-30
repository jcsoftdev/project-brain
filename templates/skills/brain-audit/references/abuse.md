# Abuse

Gate: auth, external input, or a network boundary was detected.

`Security` asks whether an attacker can break in. This module asks what a *legitimate* user can do that the system did not intend — no exploit needed, just using the product harder than expected. These findings are usually cheaper to fix and more often hit in practice.

## Resource abuse

- [ ] Every endpoint that costs money or time has a rate limit. Absent limits on expensive operations is `High` — cross-reference `cost.md` where the operation bills per call.
- [ ] Rate limits are keyed on something the user cannot trivially rotate. Per-IP alone is weak; per-account is better.
- [ ] Request and payload size are bounded before parsing, not after.
- [ ] Uploads are bounded in size, count, and total per account, and the type is verified from content rather than from the filename.
- [ ] Anything that fans out — a single request causing N downstream calls — has a bound on N.
- [ ] Expensive queries reachable by an unauthenticated caller.

## Input as a weapon

- [ ] Regexes applied to user input cannot backtrack catastrophically. Nested quantifiers over user-controlled length is a one-request denial of service.
- [ ] Recursive processing of user input (nested JSON, deeply nested structures, zip, XML) has a depth limit.
- [ ] Decompression has an output-size limit, not only an input-size limit.
- [ ] Pagination and limit parameters are clamped. `?limit=1000000` should not be honoured.
- [ ] Numeric input is range-checked; negative and zero are handled where they change behaviour.

## Enumeration

- [ ] Identifiers are not sequential where enumerating them leaks the corpus size or lets a user walk other records.
- [ ] Existence is not disclosed by differential responses — status code, message, or timing between "not found" and "not permitted".
- [ ] Bulk lookup endpoints are limited per call and per window.
- [ ] Public search cannot be used to enumerate private records by narrowing.

## Business-logic abuse

- [ ] Operations that grant value are idempotent or bounded — one coupon per account, one trial per user, one vote per poll. Cross-reference `concurrency.md`: the classic double-redeem is a read-modify-write race.
- [ ] Quotas and counters cannot be reset by the user (re-registering, changing an email, deleting and recreating).
- [ ] Ordering assumptions cannot be violated — can a user reach step 3 without steps 1 and 2? `trace_path` from each entry point to the privileged step.
- [ ] Money, credits, and quantities reject negative values everywhere, including refunds and adjustments.
- [ ] State transitions are validated against the current state, not merely applied.

## Content abuse

- [ ] User-generated content is escaped at render, and stored content cannot break out at any consumer — including emails, exports, and logs.
- [ ] CSV/spreadsheet exports neutralise formula-leading characters.
- [ ] Filenames from users are sanitised before being used on disk or in a header.
- [ ] User-supplied URLs fetched by the server are validated against internal addresses.

## Severity guidance

| Situation | Severity |
|---|---|
| Server fetches a user-supplied URL with no internal-address filter | Critical |
| No rate limit on an expensive or billed operation | High |
| Catastrophic backtracking reachable from user input | High |
| Unbounded request, payload, or decompression size | High |
| Value-granting operation that can be double-redeemed | High |
| Quota resettable by the user | Medium |
| Sequential identifiers enabling enumeration | Medium |
| Existence disclosed by differential response | Medium |
| Unclamped pagination limit | Medium |
| Export not neutralising formula characters | Low |
