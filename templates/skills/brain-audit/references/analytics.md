# Product Analytics

Can this team tell whether the product works for the people using it? Gate: a user-facing product — an analytics SDK is present, **or conspicuously absent**.

`observability.md` owns operational telemetry: logs, metrics, traces, alerts — the signals that tell the people running the system whether it is up and fast. This module owns a different audience entirely: product instrumentation, the signals that tell the team whether the product is actually working *for its users* — which flows complete, which fail, and where people give up. **Absence fires this gate rather than skipping it.** A user-facing product shipping with no instrumentation at all cannot distinguish success from failure by any means other than a support ticket, and that inability is the finding — report it once, at `High`, the same way `design-system.md` reports a missing token source, rather than as thirty separate missing events.

## Inventory

- [ ] `search_code` the analytics SDK import (Segment, Amplitude, Mixpanel, PostHog, GA4, RudderStack, or a custom `track()` wrapper) and enumerate every call site. This list is the yardstick every later check works against — nothing below means anything until this exists.
- [ ] For each `track(` call site found above, record where it fires (component, route, server handler) and what triggers it. An event fired from three different call sites for what is conceptually one user action is a red flag in its own right, addressed below.
- [ ] Server-side tracking calls, not only client SDK calls — `search_code` for a server-side analytics client or a webhook forwarding events. Distinguish these from the client inventory; they answer different reliability questions later in this module.

## Naming and shape

- [ ] Event naming convention — read a sample of event-name strings and determine which pattern the majority already follows (`snake_case` vs `Title Case`, object-action order such as `Product Viewed`/`plan_selected` vs a verb-first order), then flag the minority that breaks it. Do not import an external naming standard the project never adopted — Segment's and Amplitude's own object-action convention is the industry majority, not a rule to enforce over a project's existing, internally consistent choice.
- [ ] Action verbs are past tense, consistently — read the sample above for a mix of imperative (`Track Signup`) and past-tense (`Signup Completed`) forms within the same event set. An event fires after the action already happened; a present-tense minority alongside a past-tense majority is the same class of drift as inconsistent casing.
- [ ] The same conceptual event fired under two different names — `search_code` for near-duplicate strings (`signup_completed` and `user_registered` describing the same moment) and cross-reference the feature map from discovery to confirm they really are the same event before flagging.
- [ ] Events fired without the properties needed to answer the question they exist to answer — read the call site's property object against what the event's own name implies someone will ask (a `plan_selected` event with no plan identifier cannot answer "which plan"). **Falsify before flagging**: some SDKs auto-enrich events with context set at `identify()` or a wrapper — confirm the property is genuinely missing from the full payload, not just from this one call site.
- [ ] The same user action tracked twice from two independent call sites (a page-level listener and a component-level one both firing on one click) — `search_code` for the event name appearing at more than one site with overlapping trigger conditions, and confirm they are not deliberately distinct events sharing a name for different states.

## Tracking plan discipline

- [ ] Event and property names are fixed string literals, not built at runtime: `search_code` `track(` call sites whose first argument is a template literal, string concatenation, or a bare variable rather than a literal string. A dynamically generated event name cannot be validated against any schema and forks the taxonomy silently, one call at a time.
- [ ] A schema or generated client enforces the plan, not only a wiki page: `search_code` for a tracking-plan schema file (a JSON/YAML event catalogue, a codegen'd typed analytics client) or a CI step validating `track(` calls against it. Its absence is not itself a finding — most projects never adopt one — but if `README`/`CONTRIBUTING` claims a tracking plan exists, its absence from CI is worth surfacing as a gap between stated and actual practice.

## Funnel coverage

- [ ] For every flow `flow-integrity.md` traced, confirm its start, success, and failure are each instrumented — not only the happy path. `search_code` `track(` calls near the flow's entry point, its success branch, and its catch/error branch. **A funnel missing its failure event can only ever report success**, which makes the funnel's conversion number meaningless without anyone noticing, because nothing is technically broken.
- [ ] Empty states instrumented, not only populated ones — `search_code` `track(` calls inside a zero-result branch, an empty-list render, or an eligibility check that fails before the flow even starts. These are exactly the moments a team most needs visibility into and most often forgets to track, because nothing crashes.
- [ ] Error boundaries and caught exceptions fire a tracking event distinct from the success event — `search_code` `track(` calls inside `catch` blocks and error-boundary components, not merely a console log or an operational error report that never reaches product analytics.

## Sensitive data

- [ ] PII in event properties — cross-reference `privacy.md`; `search_code` `track(` call sites passing email, full name, phone, or any field that inventory identified as personal data.
- [ ] Free-text fields passed as event properties verbatim — `search_code` `track(` calls whose property object references a search-query, message, note, or comment field. These carry whatever the user typed, including data nobody designed the schema to hold.
- [ ] Full URLs captured as a property value — `search_code` `track(` calls passing `window.location.href` or a raw URL object — where the URL itself carries a session token or one-time link in its query string. The analytics platform then holds a credential it was never meant to receive.

## Consent and identity

- [ ] Consent gating — `search_code` for a consent-check utility wired before SDK initialisation or before the first `track()` call, in any jurisdiction where consent is required. The common real-world violation is ordering, not absence: a consent utility exists somewhere in the codebase, but the SDK init or script tag is reachable before it resolves — read the actual load order (script tag position, import order, a buffering config such as `wait_for_update`), not merely whether a consent utility exists anywhere in the repo. **Falsify before flagging**: some SDKs support a native consent-mode that buffers events until consent is granted rather than firing immediately — confirm the library's actual behaviour before reporting a violation.
- [ ] Anonymous-to-identified transition — `search_code` for an `identify()`/`alias()` call fired on login or signup, and confirm the anonymous ID collected pre-login is passed so sessions stitch together. Without this, every pre-signup event is permanently orphaned from the user it belonged to.

## Delivery and ownership

- [ ] Commercially significant events (purchase, checkout, subscription) tracked only via a client-side SDK call, with no server-side mirror — `search_code` for a corresponding server-side or webhook-driven event. Ad blockers and tracking-protection browsers drop client-side analytics calls silently; a revenue event with no server counterpart under-reports with no error anywhere in the stack.
- [ ] Development or staging traffic posting to the same analytics project as production — `search_code` for an environment-gated SDK key or write key, and confirm dev/staging events cannot land in the production dataset and skew it.
- [ ] Instrumentation still firing for a feature the codebase no longer serves — cross-reference `reachability.md`'s dead-code findings against the event inventory; a dead component still calling `track()` pollutes every dashboard reading that event with noise from a code path nobody can reach.
- [ ] A stated owner or dashboard for the event set — `search_code`/read `README`, a `CONTRIBUTING` doc, or an analytics-specific doc for a named owner or a linked dashboard. Instrumentation nobody is assigned to read decays the moment it is shipped, whether or not it is technically correct.

## Out of static reach

- Actual delivery rate — whether events fired in code are received, deduplicated, and processed correctly by the analytics platform.
- Dashboard accuracy and whether the metrics computed from these events match what the business actually reports elsewhere.
- Sampling or rate-limiting applied by the SDK or platform that silently drops a fraction of events under load.
- Whether the team actually reads the dashboard a stated owner is attached to — an assigned owner is evidence of intent, not proof of use.

## Severity guidance

| Situation | Severity |
|---|---|
| User-facing product with no analytics instrumentation at all | High |
| Commercially significant event tracked client-side only, no server mirror | High |
| PII or a token-bearing URL captured in event properties | High |
| Funnel with no failure or error event, only success | High |
| Consent-required jurisdiction with no consent gate before tracking | High |
| Same conceptual event fired under two different names | Medium |
| Event or property name built dynamically at runtime, not a fixed literal | Medium |
| Event fired without the properties its own purpose requires | Medium |
| No anonymous-to-identified stitching on login/signup | Medium |
| Dev/staging traffic landing in the production dataset | Medium |
| Dead code still firing tracking events | Low |
| No stated owner or dashboard for the event set | Low |
| Minor naming-convention drift on a small minority of events | Info / Low |
