# Cross-Surface Parity

Do the rules stated on both sides still agree? Gate: two surfaces in one repo, or shared types across them.

`contract-drift.md` owns the *schema* — OpenAPI, GraphQL, protobuf, shared type definitions — the shape of the data. This module owns something a schema cannot capture: **behavioural rules restated in prose or logic on both sides**, each internally valid, that have quietly diverged. A schema says a field is a string; it says nothing about the regex both sides are supposed to enforce on it. That gap is this module's entire scope — do not re-run `contract-drift.md`'s field-shape checks here.

Every check below has the same shape: find the rule on surface A, find its counterpart on surface B, and diff the literal values. A rule that exists on only one side is also a finding — not a match to compare, but a gap.

## Validation rules stated twice

- [ ] Max/min length constraints: `search_code` for the field name near a length check on both client and server (`maxLength`, `.max(`, `LENGTH(`, a schema `maxLength`). Diff the numbers literally — a client capping a bio at 500 characters while the server truncates or rejects at 280 is a rule that only ever fires on one side.
- [ ] Regex/format validation — email, phone, postal code, username character set — implemented independently on both sides. `search_code` for `RegExp(`, a bare `/.../ ` pattern literal, or the field name near `.test(`/`.match(` on each side; two regex literals for "valid email" are almost never identical, so diff them character by character, not by eye.
- [ ] Required-field sets: `search_code` the field name near `required`/`.notNull()`/a schema's `required: true` on the server, and near a form library's `required` prop or resolver rule on the client. A field optional client-side while the server 400s without it is bad UX, not a bug; the server accepting it as optional while the client always sends it masks a real gap — nothing ever exercises the server's optional path.
- [ ] Allowed value ranges — quantity minimums/maximums, rating scales, percentage bounds — `search_code` the field name near `min`/`max`/`.gte(`/`.lte(` on both sides and diff the literal numbers; duplicated magic numbers with no shared source are the finding even before they diverge.
- [ ] File upload limits: size cap and accepted MIME/extension list, checked independently client-side (for UX) and server-side (for safety). The server-side check is the one that matters for security — cross-reference `security.md` if the client is the *only* place a limit is enforced.

## Enum and constant sets

- [ ] A set of allowed values — category names, role names, tier names — hardcoded independently in a client dropdown and a server validator. `search_code` the value literals (`'admin'`, `'editor'`, `'viewer'`) on both sides and diff the member lists. This is the same shape as `state-model.md`'s duplicated-state-set check; if the set in question is a status/state field, report it there instead and cross-reference from here.
- [ ] Feature-gating constants (plan limits, quota thresholds): `search_code` the numeric literal or its named constant on both sides — a client-side display string ("up to 10 seats") copy-pasted rather than imported from the server's own limit means an updated limit changes enforcement but not what the UI tells the user.
- [ ] Rate-limit or quota numbers shown to the user (`"5 requests remaining"`): `search_code` the display string's source value and diff it against the server's actual configured limit — the UI promises a number the backend doesn't honour, in either direction.

## Error codes

- [ ] Enumerate every error code the server emits (`search_code` the error-construction sites, an error-code enum, or a error-response builder) and every code the client branches on (`search_code` the client's error-handling switch). Diff in both directions:
  - A code the server emits that the client has no branch for — falls through to a generic error message, losing whatever specific recovery UX was intended.
  - A code the client explicitly handles that the server never actually emits — dead client logic, and a signal the server-side behaviour changed without the client being updated.

## Defaults

- [ ] The same field defaulting to different values on client and server: `search_code` the field name near a form's `defaultValue`/initial state on the client and near `DEFAULT`/`??`/a schema default on the server, and diff the literal values. Only reachable in practice when the client fails to send the field at all (a bug elsewhere), but when it happens the two defaults silently disagree.

## Query parameter contracts

- [ ] Pagination: page-size defaults and maximums, cursor vs. offset — what the client sends versus what the server actually reads and clamps to. A client requesting `pageSize=200` against a server capping at 50 works, silently, until someone assumes the requested size was honoured.
- [ ] Sorting and filtering parameter names and accepted values: `search_code` the query-param name the client builds (`sort=`, `filter[`) versus the param name the server's route handler actually reads — a client sending `sort=createdAt` against a server that only recognises `sortBy` fails silently to a default sort, not an error.

## Authorisation decided twice

- [ ] A permission or role check performed client-side to hide a UI element: `search_code` the role/permission constant on the client, then `find_callers`/`trace_path` from the corresponding write endpoint on the server to confirm the same check exists there too. An unenforced server-side check means the client-side check is the *only* thing stopping the action, which anyone can bypass by calling the API directly. **Escalates to `security.md`**; report the finding there with a pointer back here for the parity evidence.
- [ ] The inverse, less common but real: server-side authorisation stricter than what the client believes, so the client renders an action it cannot actually complete, and the user hits an opaque 403 mid-flow.
- [ ] Session/token expiry duration: `search_code` the client's refresh-timer literal (a hardcoded interval, "refresh every 55 minutes") against the server's actual configured TTL (a JWT expiry constant, a session config value) — a client refreshing too late gets a surprise 401 mid-action instead of a seamless renewal.

## Formatting rules

- [ ] Date/time formatting and timezone handling: `search_code` for a date library import (`date-fns`, `dayjs`, `Intl.DateTimeFormat`) on each surface and check whether both call the same shared formatting function/config, or each reimplement "display in user's local time" with different rounding/timezone assumptions.
- [ ] Number and currency formatting: `search_code` for `toFixed(`, `Intl.NumberFormat`, or a hand-rolled currency string-builder on each surface — locale, decimal separator, currency symbol placement and rounding mode should trace to one shared formatter, not one per surface.
- [ ] Rounding and precision: `search_code` the monetary calculation's rounding call (`toFixed(2)`, `Math.round`, a decimal library's rounding mode) on the server and diff it against the client's own rounding of the same value. A calculation rounding to 2 decimal places on the server while the client displays more (or fewer) produces a total that visibly doesn't match its line items. Cross-reference `numeric.md` for the calculation-correctness angle; this module only checks whether the *rule* is stated consistently.

## Out of static reach

- Whether an observed divergence has actually caused a production incident, versus being latent.
- Runtime-only defaults supplied by infrastructure (a load balancer, an API gateway) that never appear in either codebase.
- Behaviour of third-party SDKs embedded in either surface that apply their own undocumented validation.
- Locale-dependent formatting differences that only manifest for locales not exercised by any test or by the auditor's reading.

## Severity guidance

| Situation | Severity |
|---|---|
| Client-only authorisation check with no server-side enforcement | Critical (defer to `security.md`) |
| Error code the client branches on that the server never emits | High |
| Validation rule enforced client-side only, unenforced server-side | High |
| File upload limit enforced only on the client | High |
| Diverged max/min or regex validation between surfaces | Medium |
| Server error code with no client handling (falls to generic message) | Medium |
| Diverged default value between client and server | Medium |
| Pagination/sort parameter mismatch silently falling back to a default | Medium |
| Formatting/rounding rule reimplemented per surface | Medium |
| Duplicated enum/constant set not yet diverged | Low |
