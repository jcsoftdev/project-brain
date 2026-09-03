# Cross-Surface Parity

Do the rules stated on both sides still agree? Gate: two surfaces in one repo, or shared types across them.

`contract-drift.md` owns the *schema* — OpenAPI, GraphQL, protobuf, shared type definitions — the shape of the data. This module owns something a schema cannot capture: **behavioural rules restated in prose or logic on both sides**, each internally valid, that have quietly diverged. A schema says a field is a string; it says nothing about the regex both sides are supposed to enforce on it. That gap is this module's entire scope — do not re-run `contract-drift.md`'s field-shape checks here.

Every check below has the same shape: find the rule on surface A, find its counterpart on surface B, and diff the literal values. A rule that exists on only one side is also a finding — not a match to compare, but a gap.

## Validation rules stated twice

- [ ] Max/min length constraints: `search_code` for the field name near a length check on both client and server (`maxLength`, `.max(`, `LENGTH(`, a schema `maxLength`). Diff the numbers literally — a client capping a bio at 500 characters while the server truncates or rejects at 280 is a rule that only ever fires on one side. Rule out a documented reason for the gap (a comment, a note about a second consumer) before flagging a client-stricter-than-server divergence as unintentional. "Input validation must be implemented on the server-side before any data is processed... any JavaScript-based input validation performed on the client-side can be circumvented" (OWASP Foundation, OWASP Cheat Sheet Series, current, https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html).
- [ ] Regex/format validation — email, phone, postal code, username character set — implemented independently on both sides. `search_code` for `RegExp(`, a bare `/.../ ` pattern literal, or the field name near `.test(`/`.match(` on each side; two regex literals for "valid email" are almost never identical, so diff them character by character, not by eye. For a validation rule reimplemented on both surfaces, `Read` the full conditional structure, not just the headline literal — a branch present on one side and absent on the other (an exemption, an early-return, an extra OR-condition) means the core rule matches but the edge-case coverage silently diverges. Report which side carries the extra branch and what input only that side accounts for; this is exactly a Type III "near-miss" clone — code matching a counterpart "except for added or removed statements" (Roy & Cordy, Technical Report TR 2007-541, Queen's University School of Computing, 2007, https://research.cs.queensu.ca/TechReports/Reports/2007-541.pdf). Refuted if the extra branch is a documented platform-specific exemption (a comment, an ADR reference, a legal requirement scoped to one storefront) rather than an accidental omission.
- [ ] Required-field sets: `search_code` the field name near `required`/`.notNull()`/a schema's `required: true` on the server, and near a form library's `required` prop or resolver rule on the client. A field optional client-side while the server 400s without it is bad UX, not a bug; the server accepting it as optional while the client always sends it masks a real gap — nothing ever exercises the server's optional path. Recommends both: client-side validation for UX, server-side validation as the actual security control (OWASP Foundation, OWASP Cheat Sheet Series, current, https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html).
- [ ] Allowed value ranges — quantity minimums/maximums, rating scales, percentage bounds — `search_code` the field name near `min`/`max`/`.gte(`/`.lte(` on both sides and diff the literal numbers; duplicated magic numbers with no shared source are the finding even before they diverge (OWASP Foundation, OWASP Cheat Sheet Series, current, https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html).
- [ ] File upload limits: `search_code` the size cap and accepted MIME/extension list near the upload handler on both client (for UX) and server (for safety), and diff them. The server-side check is the one that matters for security — cross-reference `security.md` if the client is the *only* place a limit is enforced. "The Content-Type for uploaded files is provided by the user, and as such cannot be trusted, as it is trivial to spoof"; the size check itself must be applied "after file decompression" — "no one technique is enough to secure the service" (OWASP Foundation, OWASP Cheat Sheet Series, current, https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).

## Shared-type package drift

- [ ] When both surfaces sit in one workspace (npm/pnpm/yarn workspaces, Turborepo, Nx), `search_code` for a request/response interface or type independently declared on both client and server for the same endpoint payload, then `find_callers`/`search_code` to confirm neither imports it from a shared internal package (`workspace:*`, `@repo/*`, an Nx model/`libs/shared` project). Two independently declared types for the same payload — even currently identical — have no single source of truth; flag it before it diverges, not after. Internal Packages exist precisely so "application packages" don't each hold their own copy of shared code (Vercel / Turborepo docs team, official framework documentation, current, https://turborepo.dev/docs/core-concepts/internal-packages), and Nx documents a dedicated "Model" project type specifically for "sharing interfaces between backend and frontend" (Nx core team, Nx official blog, current, https://nx.dev/blog/virtuous-cycle-of-workspace-structure). Refuted if one of the two declarations is a deliberately narrower client-side view model (omitting server-only fields such as internal audit metadata) rather than a full duplicate — confirm the field sets aren't a legitimate subset/superset relationship before flagging.

## Enum and constant sets

- [ ] A set of allowed values — category names, role names, tier names — hardcoded independently in a client dropdown and a server validator. `search_code` the value literals (`'admin'`, `'editor'`, `'viewer'`) on both sides and diff the member lists. This is the same shape as `state-model.md`'s duplicated-state-set check; if the set in question is a status/state field, report it there instead and cross-reference from here. This is a Type I/II clone — matching "modulo whitespace/comments" or "modulo renamed identifiers/literals/types" (Roy & Cordy, Technical Report TR 2007-541, Queen's University School of Computing, 2007, https://research.cs.queensu.ca/TechReports/Reports/2007-541.pdf).
- [ ] Feature-gating constants (plan limits, quota thresholds): `search_code` the numeric literal or its named constant on both sides — a client-side display string ("up to 10 seats") copy-pasted rather than imported from the server's own limit means an updated limit changes enforcement but not what the UI tells the user.
- [ ] Rate-limit or quota numbers shown to the user (`"5 requests remaining"`): `search_code` the display string's source value and diff it against the server's actual configured limit — the UI promises a number the backend doesn't honour, in either direction.
- [ ] When the same business rule (a fee calculation, an eligibility check, a discount formula) is `search_code`-findable as independently implemented in three or more places across the surfaces — not just two — report it as an elevated parity-maintenance risk even while all copies currently agree. A rule with N independent implementations needs N synchronized edits every time it changes, and each additional copy raises the odds one is missed. Refuted if the N call sites are not independent implementations — they all delegate to one shared function or constant, just invoked from N places (which is fine). Only flag when the comparison logic or literal itself is copy-pasted N times, not merely called N times.

## API version pin

- [ ] When the server implements date-based or numbered API versioning, `search_code` the client's pinned version literal (a version header, a `/v2/` path segment, an SDK version constant) and `search_code`/`find_symbol` the server's registered version handlers or the version range it still serves. A client pinned to a version the server no longer routes falls back silently to the server's default version's behaviour, not the one the client's code assumes — the entire discipline of pinned API versioning exists because "fields that were present before should stay present, and fields should always preserve their same type and name" for a given pin (Stripe Engineering, official company engineering blog, current, https://stripe.com/blog/api-versioning). Refuted if the server's versioning layer documents the fallback as a safe no-op (a changelog or deprecation policy stating the removed version maps forward with identical behaviour) — check the migration docs before flagging.

## Error codes

- [ ] Enumerate every error code the server emits (`search_code` the error-construction sites, an error-code enum, or a error-response builder) and every code the client branches on (`search_code` the client's error-handling switch). Diff in both directions:
  - A code the server emits that the client has no branch for — falls through to a generic error message, losing whatever specific recovery UX was intended.
  - A code the client explicitly handles that the server never actually emits — dead client logic, and a signal the server-side behaviour changed without the client being updated.

## Defaults

- [ ] The same field defaulting to different values on client and server: `search_code` the field name near a form's `defaultValue`/initial state on the client and near `DEFAULT`/`??`/a schema default on the server, and diff the literal values. Only reachable in practice when the client fails to send the field at all (a bug elsewhere), but when it happens the two defaults silently disagree.

## Query parameter contracts

- [ ] Pagination: `search_code` the page-size default/maximum and cursor-vs-offset parameter on both client and server, and diff what the client sends against what the server actually reads and clamps to. A client requesting `pageSize=200` against a server capping at 50 works, silently, until someone assumes the requested size was honoured.
- [ ] Sorting and filtering parameter names and accepted values: `search_code` the query-param name the client builds (`sort=`, `filter[`) versus the param name the server's route handler actually reads — a client sending `sort=createdAt` against a server that only recognises `sortBy` fails silently to a default sort, not an error.

## Authorisation decided twice

- [ ] A permission or role check performed client-side to hide a UI element: `search_code` the role/permission constant on the client, then `find_callers`/`trace_path` from the corresponding write endpoint on the server to confirm the same check exists there too. An unenforced server-side check means the client-side check is the *only* thing stopping the action, which anyone can bypass by calling the API directly. **Escalates to `security.md`**; report the finding there with a pointer back here for the parity evidence. This is CWE-602, Client-Side Enforcement of Server-Side Security: "the product is composed of a server that relies on the client to implement a mechanism that is intended to protect the server" (MITRE, CWE-602, official weakness catalogue, current, https://cwe.mitre.org/data/definitions/602.html); OWASP's own guidance is equally direct — "developers must never rely on client-side access control checks... client-side logic is often easy to bypass" (OWASP Foundation, OWASP Cheat Sheet Series, current, https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html). This is not hypothetical: CVE-2025-41402 is a dated, CVSS 5.5 instance of exactly this class in production software (GitHub Security Lab / GitHub Advisory Database, official advisory record, 2025, https://github.com/advisories/GHSA-hvh2-99r5-r38q).
- [ ] The inverse, less common but real: server-side authorisation stricter than what the client believes — `find_symbol` the server-side authorisation check and `Read` its condition, then `search_code` the client's render guard for the same role/permission constant and diff the two; a client renders an action it cannot actually complete, and the user hits an opaque 403 mid-flow. Checks must be server-side, at the gateway, or in a serverless function — never decided by what the client renders (OWASP Foundation, OWASP Cheat Sheet Series, current, https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).
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
- Whether the two surfaces observed are running the same deployed commit as the one this audit read — this module reads source, not deploy state.
- Whether identical source-level validation logic behaves identically across the runtime engines each surface actually executes in — this module diffs code, not engines.
- Validation performed inside a third-party SDK's own code on either surface — this module diffs the application's own logic, not vendored dependencies.
- Two differing implementations gated behind a feature flag — this module cannot tell from source alone which is the active variant for any given request.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl` | Runtime-only defaults supplied by infrastructure (a load balancer, an API gateway), visible in response headers during a walked flow, that never appear in either codebase | Medium |
| `network.jsonl` (actual emitted code), cross-referenced with `search_code` on the client | A server error code observed live on a walked flow has no matching branch in the client's error-handling switch. Refuted if the flow's own outcome shows a generic-but-adequate fallback message was still shown to the user, not a broken/blank state | High |
| `steps.md` (rendered client error text) + `network.jsonl` (server's actual 4xx body) | A client-side validation error message, rendered after one deliberately invalid, non-side-effecting submission, disagrees with the server's actual rejection text/constraint for the same input. Refuted if the two messages describe the same constraint in different words (a wording gap, not a rule gap) | Medium |
| `network.jsonl` request headers/URL | The API version header/path actually sent by the client differs from the version literal `search_code` finds hardcoded in the client's own source, or from what the server's routing table accepts. Refuted if a build-time env substitution legitimately overrides the source literal for this environment | Medium |

## Severity guidance

| Situation | Severity |
|---|---|
| Client-only authorisation check with no server-side enforcement (defer to `security.md`) | Critical |
| Error code the client branches on that the server never emits | High |
| Validation rule enforced client-side only, unenforced server-side | High |
| File upload limit enforced only on the client | High |
| Diverged max/min or regex validation between surfaces | Medium |
| Server error code with no client handling (falls to generic message) | Medium |
| Diverged default value between client and server | Medium |
| Pagination/sort parameter mismatch silently falling back to a default | Medium |
| Formatting/rounding rule reimplemented per surface | Medium |
| Validation rule's edge-case branch present on one surface, absent on the other (core rule agrees) | Medium |
| Client pinned to an API version the server no longer routes | Medium |
| Duplicated enum/constant set, or the same business rule reimplemented 3+ times, not yet diverged | Low |
| Independently declared client/server type for the same payload with no shared internal-package source | Low |
