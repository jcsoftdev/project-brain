# Abuse

Gate: auth, external input, or a network boundary was detected.

`Security` asks whether an attacker can break in. This module asks what a *legitimate* user can do that the system did not intend — no exploit needed, just using the product harder than expected. These findings are usually cheaper to fix and more often hit in practice.

## Resource abuse

- [ ] Every endpoint that costs money or time has a rate limit. `search_code` for a rate-limit middleware (`express-rate-limit`, `slowapi`, `RateLimiter`, `@Throttle`, or the project's own), then list the routes it actually wraps against every expensive or billed route from `get_architecture`'s route table. The gap between the two lists is the finding — the mere absence of the word "rate limit" is not; a project can rate-limit at the gateway and never mention it in application code, so check for an upstream gateway config too before concluding there is none. CWE-770 Allocation of Resources Without Limits or Throttling, #25 in the 2025 CWE Top 25 — the CWE anchoring this whole section. Absent limits on a billed operation is `High` — cross-reference `cost.md`.
- [ ] Rate limits are keyed on something the user cannot trivially rotate. Read the limiter's key function: per-IP alone is weak (rotates behind CGNAT or a VPN); per-account or per-API-key is better. OWASP Credential Stuffing Prevention Cheat Sheet: "blocking IP addresses may be sufficient to stop less sophisticated attacks, but should not be used as the sole or primary defense due to the ease in circumvention."
- [ ] Request and payload size are bounded before parsing, not after. `search_code` the body-parser configuration (`bodyParser.json({limit:`, `express.json({limit:`, `client_max_body_size`, framework equivalent) and confirm the limit is wired into the middleware chain ahead of the route, not merely declared and unused. CWE-770 Allocation of Resources Without Limits or Throttling.
- [ ] Uploads are bounded in size, count, and total per account, and the type is verified from file content rather than filename or declared MIME type. `find_symbol` the upload handler and read the validator: an extension or `Content-Type` header check alone is the finding; a check against magic bytes (file-type sniffing) rules it out — read which one is actually implemented before flagging. CWE-434 Unrestricted Upload of File with Dangerous Type, #12 in the 2025 CWE Top 25.
- [ ] Anything that fans out — a single request causing N downstream calls — has a bound on N. `find_callees` or `trace_path` from the handler: a loop over a user-supplied array (batch IDs, recipient lists, webhook targets) calling a downstream service once per item, with no cap on array length, is the finding. Rule out: a cap enforced by the request schema before the handler runs — confirm the schema, not just the loop, before flagging. CWE-770 Allocation of Resources Without Limits or Throttling, #25 in the 2025 CWE Top 25; toll fraud (Twilio) is a real-world instance where an attacker fans out calls/messages to many attacker-rented premium-rate destinations, with the victim absorbing telecom costs.
- [ ] Where a single account can trigger a message, call, or notification to an arbitrary destination the account does not own (SMS/OTP send, voice call, webhook, email-to-external-address), the limit is keyed on the destination as well as the account — one attacker-controlled account requesting OTPs or calls to many different attacker-chosen premium-rate numbers is the same fan-out shape as the check above, but a per-account limit alone does not catch it because the account itself never exceeds its own quota. `find_callers`/`trace_path` from the send handler to the messaging/telephony provider call and read whether the rate-limit key includes the destination. Twilio's own account of International Revenue Sharing Fraud / toll fraud — a real, named abuse pattern where the attacker's leverage is exactly "many premium destinations, one or few source accounts."
- [ ] Signup, trial-activation, and any other identity-minting endpoint has a control that a generic per-account rate limit cannot provide — a CAPTCHA/proof-of-work challenge, disposable-email or VOIP-number rejection, or a velocity check across a device/browser fingerprint — because the attacker's unit of abuse here is the account itself. `search_code` the registration/trial handler for a captcha/verification-provider call (`recaptcha`, `hcaptcha`, `turnstile`, `verify-email`) alongside the account-creation write; its total absence on a route that mints a billable trial or a resource-granting account is the finding. OWASP OAT-019 "Account Creation" (Automated Threats to Web Applications) — a distinct threat class from generic resource exhaustion.
- [ ] A request rejected for rate-limiting returns HTTP 429 (not a bare 403/500) so a well-behaved client can distinguish "back off" from "you are banned" or "the server errored," and, where the codebase already returns structured error bodies elsewhere, includes a `Retry-After` value or equivalent backoff hint on the 429 response. `search_code` the rate-limit middleware's response construction for the literal status code and header. RFC 6585 §4 defines 429 and `Retry-After` normatively; Stripe's layered rate-limit design keys a `Stripe-Rate-Limited-Reason` header specifically so callers can self-correct instead of retrying blindly into the same wall.
- [ ] Expensive queries reachable by an unauthenticated caller — expensive means a join count, an unindexed/full-table scan, or an unbounded aggregate `find_symbol` shows in the query. Cross-list unauthenticated routes (from the route table) against `repo_map`'s top-ranked symbols or any such query `find_symbol` turns up on those routes. Rule out: a query that is already paginated, cached, or covered by a rate limit elsewhere in the pipeline is not the finding — confirm none of the three apply before flagging.

## Input as a weapon

- [ ] Regexes applied to user input cannot backtrack catastrophically. `search_code` regex literals for nested-quantifier shapes (`(.*)+`, `(.+)+`, `(\w+)+`, or a group with a `+`/`*` quantifier itself quantified). Rule-out: trace the regex's input with `find_callers` — a pattern applied only to a trusted, internal, or fixed-length string is not user-reachable and is not the finding; confirm the input source before flagging. CWE-1333 Inefficient Regular Expression Complexity — worked vulnerable pattern is exactly this nested-quantifier shape.
- [ ] Recursive processing of user input (nested JSON, deeply nested structures, zip, XML) has a depth limit. `search_code` the parser's configuration for a `maxDepth`/`depthLimit` option; its absence in a JSON parser that accepts arbitrary client bodies is the finding.
- [ ] Decompression has an output-size limit, not only an input-size limit. `search_code` calls into `zlib`, `gunzip`, or archive-extraction libraries for a cap on decompressed output size — a zip bomb passes any input-size check trivially.
- [ ] Pagination and limit parameters are clamped server-side. `find_symbol` the list/pagination handler and read whether the `limit` value is clamped (`Math.min(limit, MAX)` or equivalent) before being used in the query — a limit merely validated as "is a number" still lets `?limit=1000000` through. CWE-770 Allocation of Resources Without Limits or Throttling.
- [ ] Numeric input is range-checked; negative and zero are handled where they change behaviour. `search_code` the validation schema (`zod`, `joi`, `pydantic`, class-validator, or the project's own) for the field and check it declares a `min`/`max`, not just a type.

## Enumeration

- [ ] Identifiers are not sequential where enumerating them leaks the corpus size or lets a user walk other records. `search_code` the schema for autoincrement primary keys, then trace whether that same ID is the one exposed in a URL or API response. Rule-out: an autoincrement PK used only internally, with a separate opaque public ID (UUID, slug) surfaced to clients, is not the finding — confirm which ID actually appears in the client-facing route before flagging. This is the enumeration half of BOLA (OWASP API Security Top 10:2023 API1, CWE-639) — `security.md`'s AuthZ section owns the missing-ownership-check half of the same defect; report the identifier choice here and the missing check there.
- [ ] Existence is not disclosed by differential responses. `find_symbol` the handler and read the literal "not found" and "not permitted" branches side by side — same status code, same body shape, or the finding names the exact difference. OWASP Authentication Cheat Sheet: an application "must respond (both HTTP and HTML) in a generic manner" regardless of whether the user, password, or account status is invalid.
- [ ] Where the "not found" and "not permitted" branches return the same status and body (the check above), also read whether they do comparable work before responding — a "not found" branch that returns immediately after a cheap existence check, next to a "not permitted" branch that first loads the record, hashes a password, or performs an authorization check, is a timing side-channel even when the two responses are byte-identical. `find_symbol` both branches and compare the operations each performs before the shared response is built. OWASP Authentication Cheat Sheet: differing processing time, not just differing response body/status, is itself an enumeration channel, and the fix is equal work on both paths.
- [ ] Bulk lookup endpoints are limited per call and per window. `find_symbol` the batch endpoint and check for a cap on the incoming ID array's length. CWE-770 Allocation of Resources Without Limits or Throttling.
- [ ] Where a listing or export endpoint's per-request `limit`/page size is already clamped (above), also check for a cap on cumulative volume per account or window — cursor-based pagination with no per-request cap violation still lets a caller walk the entire corpus by paging through it slowly, which a request-level clamp cannot see. `search_code` the pagination/export handler for a per-account daily/hourly export-volume counter distinct from the per-request `limit` clamp. OWASP OAT-011 "Scraping" (Automated Threats to Web Applications) — collecting application content at scale is a threat distinct from a single oversized request.
- [ ] Public search cannot be used to enumerate private records by narrowing filters. Read the search handler's filter set for combinations (e.g. narrowing by email domain plus name prefix) that converge on a single private record through repeated queries.

## Business-logic abuse

- [ ] Operations that grant value are idempotent or bounded — one coupon per account, one trial per user, one vote per poll. `find_symbol` the redeem/apply-coupon/vote handler and read whether the check-then-write is inside a transaction or backed by a unique constraint, versus a plain read-check-write with no such guard. Cross-reference `concurrency.md`: the classic double-redeem is a race, and this check only confirms the *logic* exists — the race itself is that module's finding.
- [ ] Quotas and counters cannot be reset by the user re-registering, changing an email, or deleting and recreating an account. `find_symbol` the registration/account handler and check whether the quota key is the mutable field being changed (email) rather than an immutable identifier issued at first creation.
- [ ] Ordering assumptions cannot be violated — can a user reach step 3 without steps 1 and 2? `trace_path` from each entry point to the privileged step; a path that reaches it without passing through the earlier steps' handlers is the finding.
- [ ] Money, credits, and quantities reject negative values everywhere, including refunds and adjustments. `search_code` the amount/quantity validation schema for a `min(0)`-equivalent constraint, and check the refund and adjustment handlers specifically — these are often left unguarded even when the primary charge path validates correctly, because they are added later and copy less carefully.
- [ ] State transitions are validated against the current state, not merely applied. `find_symbol` the transition function and read whether it checks the record's current state before writing the new one, or performs a blind assignment reachable from any state.

## Content abuse

- [ ] Stored user-generated content cannot break out at any consumer beyond the render path — including emails, exports, and logs. `search_code` for the content reaching an email template, export generator, or log formatter with no escaping/sanitisation applied there specifically. Render-path escaping itself (autoescape setting, `dangerouslySetInnerHTML`, `| safe`) is owned by `security.md` (`search_code` for `innerHTML`/`dangerouslySetInnerHTML`/`v-html`) — reuse its finding for that sink, do not re-report it here.
- [ ] CSV/spreadsheet exports neutralise formula-leading characters. `find_symbol` the export function and read whether it prefixes cells starting with `=`, `+`, `-`, or `@` before writing them.
- [ ] Filenames from users are sanitised before being used on disk or in a header. `find_symbol` the upload handler and read whether the stored filename is the raw client-supplied string or a sanitised/generated one (hash, UUID, stripped path). CWE-434 Unrestricted Upload of File with Dangerous Type — recommends generating a new, unique filename for storage rather than trusting the client-supplied one.
- [ ] User-supplied URLs fetched by the server are validated against internal and private addresses before the request is made. `search_code` for outbound HTTP calls (`fetch(`, `axios.get(`, `requests.get(`, `http.request(`) where the URL argument traces back to user input via `find_callers`, and check for an allowlist (preferred) or private-IP/link-local/loopback-range rejection ahead of the call — its absence on a server-side fetch of a user-supplied URL is the SSRF finding and is `Critical`. CWE-918, #22 in the 2025 CWE Top 25; SSRF is no longer its own OWASP Top 10 category — it was folded into A01:2025 Broken Access Control — cite CWE-918 or OWASP API Security Top 10:2023 API7 (SSRF) instead of "OWASP A10".
- [ ] Where the private-address check exists, it runs against the *resolved* IP immediately before the connection, not only against the hostname string at input-validation time. Read the validation call site and the fetch call site together — if a DNS lookup can occur between the two (the check validates the hostname, then a separate resolve happens inside the HTTP client), an attacker-controlled DNS record can rebind a passing hostname to a private address after the check runs. A validator that resolves A/AAAA records itself and checks those IPs, immediately before the same connection is made, rules this out. OWASP SSRF Prevention Cheat Sheet: an allowlisted domain must be re-checked after resolution, since it can later resolve to a local or internal IP; where an allowlist is infeasible, the deny-list of last resort is `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, plus cloud metadata endpoints such as `169.254.169.254`.

## Out of static reach

- Real behaviour under load — whether a rate limit actually holds at the traffic the endpoint sees in production, versus merely being configured.
- Upstream WAF, CDN, or API-gateway rate limiting and payload-size enforcement that never appears in application source.
- Whether a third-party payment or coupon provider enforces idempotency independently of this codebase's own guard.
- Real-world timing differences for enumeration — network jitter can mask a gap that is clearly visible when reading the two code paths side by side, and can also expose one too small to see in source.
- Whether the business rules encoded here match the product's actual legal or ToS constraints (refund windows, promotional limits) — that is a policy document this module cannot read.
- Whether a CAPTCHA or bot-challenge actually stops automated traffic in production — this module can confirm the control exists, not that it works.
- Multi-account or multi-identity coordinated abuse rings — no single code path this module reads spans account boundaries.
- The tuning of any third-party bot-mitigation or fraud-scoring threshold — that configuration lives outside this codebase.
- The dollar cost of an unbounded per-destination fan-out if exploited — that number lives in a carrier rate card, not the codebase.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl` | Real-world timing difference between the "not found" and "not permitted" paths, driven through a live session | High |
| `a11y-snapshot.md` / `read_page` | Whether a signup/trial-abuse control (CAPTCHA/challenge widget) is actually rendered to a real, non-authenticated visitor | Info |
| `routes.md` | A route missed by the static route inventory but found by the live crawl, added to the denominator before "expensive queries reachable by an unauthenticated caller" is scored clean | Info |
| `network.jsonl` (or `resource-perf.md`) | Response payload size compared against the declared page-size clamp read from source, for the cumulative-export-volume check | Medium |

## Severity guidance

| Situation | Severity |
|---|---|
| Server fetches a user-supplied URL with no internal-address filter | Critical |
| Internal-address filter checks the hostname but not the resolved IP (DNS-rebinding gap) | High |
| No rate limit on an expensive or billed operation | High |
| Catastrophic backtracking reachable from user input | High |
| Unbounded request, payload, or decompression size | High |
| Value-granting operation that can be double-redeemed | High |
| Quota resettable by the user | Medium |
| Sequential identifiers enabling enumeration | Medium |
| Existence disclosed by differential response | Medium |
| Unclamped pagination limit | Medium |
| Export not neutralising formula characters | Low |
| Fan-out limit keyed by account only, not by destination, on a caller-chosen destination (toll fraud shape) | High |
| "Not found"/"not permitted" branches do unequal work before an identical response (timing side-channel) | Medium |
| Cumulative export/listing volume uncapped across requests, only per-request page size clamped | Low |
| Identity-minting endpoint (signup/trial) with no signup-specific abuse control | Medium |
| Rate-limited response not machine-distinguishable (no 429/`Retry-After`) | Low |
