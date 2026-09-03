# Privacy

Gate: personal data or user data is persisted.

Distinct from `Security`, which asks whether data can be stolen. This module asks whether the system should have the data at all, whether it goes places nobody intended, and whether the user can get it out or get it deleted.

## Inventory first

You cannot audit what you have not enumerated, and unlike most modules in this skill, the inventory here is not inference — **the schema's field names are the probe, and they are already sitting in plain text.** Read them literally before doing anything else; every later section reuses this list rather than rediscovering fields case by case.

- [ ] `search_code` schema, model, and migration files (or `get_module` on the data-layer module) and read every column and field name against a checklist: name, email, phone, address, IP, device id, precise location / lat / lng, government id, payment or card details, biometrics, health, date of birth — and anything a foreign key derives from these. This single pass is the inventory; do not skip it and guess later. The two-tier split — ordinary identifiers versus the higher-sensitivity group (government id, payment details, biometrics, health) — follows NIST SP 800-122's PII confidentiality-impact-level framework (echoed in DHS's separate sensitive-PII terminology); treat a hit in the sensitive group as the stronger finding when the same gap (no stated purpose, no retention limit) applies to both.
- [ ] Free-text columns count and cannot be enumerated by name alone — `search_code` for columns named `notes`, `comment`, `bio`, `description`, `message`, `feedback`. Flag each as "unbounded content, requires manual read of sample call sites" rather than pretending the column name tells you what is inside it.
- [ ] For each inventoried field, trace its lifecycle: `find_callers` on its accessor to see where it is read, `trace_path` from the API input that sets it to the write that persists it. Where it enters, where it lands, and what touches it in between is the row this checklist is actually building.
- [ ] Collected-but-never-read fields are the cheapest finding in this module. `find_callers` on the read path for the column — empty, with `Reachability`'s exclusions in `reachability.md` ruled out, means it is a candidate. Stop collecting it rather than justifying it. This reuses `database.md`'s general dead-column sweep, filtered to the PII inventory — don't re-run the search, cross-check the inventory against `database.md`'s findings.

## Egress — where does it go

- [ ] Enumerate third parties first: `get_architecture` dependencies plus `search_code` for known SDK imports — analytics, error reporting, logging platforms, LLM providers, support-tool SDKs, CDNs. A third party you have not named cannot be checked.
- [ ] **Error reports and logs are the most common accidental egress.** `search_code` the error-reporting SDK's capture call (`Sentry.captureException`, `.captureMessage`, or equivalent) and read literally what is passed — a scrubbed error object, or the full request with headers and body attached. OWASP Logging Cheat Sheet: sensitive PII "should not be recorded directly in the logs, but instead should be removed, masked, sanitized, hashed, or encrypted."
- [ ] **Prompts are egress.** `search_code` the LLM SDK call site and read what is interpolated into the messages/prompt argument against the field inventory above — if an inventoried field lands there, that data left the system. Cross-reference `ai.md`. OWASP Top 10 for LLM Applications, LLM02:2025 Sensitive Information Disclosure.
- [ ] `search_code` the LLM SDK call site's system/developer-role prompt template specifically (not the per-request user message) for a hardcoded credential, connection string, or literal inventoried PII value baked into the template itself — distinct from the check above, this is data placed in the prompt once, by the developer, not per-request by user input. A placeholder token (e.g. `{{api_key}}`) resolved at runtime from a secrets manager is not the finding; a literal secret in source is. OWASP Top 10 for LLM Applications, LLM07:2025 System Prompt Leakage — "sensitive data such as credentials, connection strings, etc. should not be contained within the system prompt language."
- [ ] Wherever the "Prompts are egress" check above confirms an inventoried field reaches an LLM call, `search_code` that same call site's request options for a documented no-training / zero-data-retention parameter (a provider-specific opt-out flag, e.g. a `store` or `retention` option) — its absence is reported once per provider integration, not once per call site. `undetermined`, not a violation, where the repo's own docs reference a DPA or enterprise zero-retention agreement covering that provider. OWASP LLM02:2025 — sanitisation "to prevent user data from entering the training model," with the explicit caveat that opt-out restrictions "may not always be honored."
- [ ] Client-side scripts that read personal data from the page or from storage: `search_code` `localStorage`/`sessionStorage`/cookie reads adjacent to an analytics `track()`/`identify()` call — the adjacency is what makes it egress rather than a UI convenience.
- [ ] Backups, exports, and fixtures — `search_code` test fixtures and seed files for realistic-looking emails and names. **Rule out first:** `example.com`, `test@test.com`, and obviously synthetic names (`Jane Doe`, `Test User`) are not the finding. A fixture using a real corporate domain, or a name that resolves to an actual person, is — confirm which one you are looking at before reporting it.

## Minimisation

- [ ] "Each field has a stated purpose" is not checked field-by-field on suspicion — walk the inventory list and, for each entry, `Read` the schema/model file and any data-dictionary doc (or `get_module` on the data layer, which the inventory check above already uses) for a comment, schema doc, or data dictionary entry stating why it is collected. Report the absence once, across the whole inventory, with the count of fields with no stated purpose — not as N separate findings. GDPR Art. 5(1)(b): personal data must be "collected for specified, explicit and legitimate purposes."
- [ ] Precision: `Read` the field's declared type against what the feature needs — a `timestamp` where a year would do, a `lat`/`lng` pair where a region would do. The schema states the precision directly; no inference needed. Rule out precision required for audit/fraud/legal retention even where the user-facing feature only needs a coarser value — the finding is precision beyond every purpose, not beyond the one feature read first. GDPR Art. 5(1)(c): data minimisation — "adequate, relevant and limited to what is necessary."
- [ ] Pseudonymous where possible: `search_code` whether downstream tables and services key on the real PII field (email, phone) directly, or on an internal id that only resolves to PII at one boundary. GDPR Art. 25 and recital 78 name "pseudonymising personal data as soon as possible" as an example data-protection-by-design measure.
- [ ] For each inventoried field found at a log call site (the check below), `find_callers` the logging platform's redact/scrub/mask helper, where one exists in the codebase, to confirm that specific call site is actually wrapped by it — rather than assuming a redaction utility's mere existence protects every call site that logs an inventoried field. A call site logging a field outside the sensitive inventory (e.g. a status code sitting next to the flagged variable in the same statement) is not the finding — re-confirm the specific argument logged before flagging.
- [ ] PII in a URL or in logs: `search_code` route definitions for path parameters shaped like `:email`, `:phone`, `/user/:name`, and logger call sites that would capture a query string carrying one of the inventoried fields. `observability.md` owns the log-quality/structure angle; `privacy.md` owns the compliance/inventory angle — report a given hit once. A hit that is both takes `observability.md`'s `High`, not this module's lower severity for the same file:line. OWASP Logging Cheat Sheet: sensitive PII "should not be recorded directly in the logs, but instead should be removed, masked, sanitized, hashed, or encrypted."

## Retention and deletion

- [ ] Retention enforced, not just declared: for each store the inventory names, `search_code` for a scheduled job, cron entry, or TTL index tied to it. A store with no matching job is a policy with no enforcement — report it as such, don't assume one exists off-repo. Cross-reference `scalability.md`'s bounded-storage sweep — reuse its findings for the PII-tagged stores rather than re-running the search. GDPR Art. 5(1)(e): storage limitation — personal data "kept... for no longer than necessary."
- [ ] Deletion completeness is a diff, not a guess: `find_callers` on the account/data-deletion handler, then `find_callees` to enumerate every store it actually touches. The gap between that set and the full inventory from the first section is the finding — name the stores deletion misses. GDPR Art. 17: erasure grounds ("no longer necessary," consent withdrawn), subject to lawful-retention exceptions (legal obligation, archiving/research/statistics, freedom of expression).
- [ ] Soft delete: `find_symbol` the delete function and read its body — does it set a flag/mark a row, or actually remove or anonymise it? Then check whether user-facing copy (`search_code` the confirmation string) calls this "delete" when it is really a flag flip.
- [ ] Log retention: `search_code` the logging platform's retention or TTL configuration and compare it against how long the inventoried fields persist elsewhere — a log line living longer than the record it was copied from is the finding. OWASP Logging Cheat Sheet: logs "must not be destroyed before the duration of the required data retention period, and must not be kept beyond this time."

## User rights

- [ ] Export completeness: `find_symbol` the export/data-download handler, `find_callees` from it, and compare the fields it actually serialises against the full inventory — a data export returning the profile table only, while the inventory lists five other stores, is the finding, named field by field.
- [ ] Deletion requestable: `search_code` for a deletion-request endpoint, or its documented process if the flow is manual (support ticket, admin action) — either counts, but one of them must exist and be discoverable from the code.
- [ ] Consent recorded: `search_code` the schema for a `consent`/`consented_at`-shaped column, then `find_callers` on it to confirm it is actually checked before the gated use, not merely written and ignored. ePrivacy Directive 2002/58/EC Art. 5(3): storing or accessing information on a user's terminal equipment (cookies, local storage) requires the user be given clear information and "offered the right to refuse" beforehand, with narrow exceptions for technically necessary transmission or an explicitly requested service.
- [ ] `trace_path` from the page-load or app-initialisation entry point to the analytics/tracking SDK's init or cookie-set call — a path that reaches it with no consent-check conditional in between is a pre-consent storage/access violation, not merely a missing banner; a path reaching it only through a consent-granted branch is a pass. A reached call that sets a strictly-necessary cookie (session id, CSRF token, load-balancer routing), exempted under ePrivacy's narrow exceptions, is not the finding — name which exception applies before ruling this a violation rather than a pass.
- [ ] Defaults: `Read` the signup or settings handler for a data-sharing/marketing flag and its default value in the schema or the handler's initial-state literal — defaulting to opted-in is the finding. Also read the front end: `search_code`/`Read` the signup or settings component for the same flag's rendered checkbox — a `checked`, `defaultChecked`, or equivalent pre-selected prop is still an opt-in default violated in the browser, even when the backend default is `false`. Rule out a checkbox gating a strictly-necessary confirmation (age attestation, terms-of-service acknowledgement) rather than a marketing/data-sharing purpose. GDPR Art. 25 and recital 78: data-protection-by-design/-default.
- [ ] Opt-out signal handling: `search_code` for `Sec-GPC` or Global Privacy Control handling and, where present, trace whether it drives a visible confirmation state (an "opt-out honoured" indicator) rather than only a silent internal flag flip — CCPA/CPRA (11 CCR §7022) requires the confirmation be visible to the user. Its total absence in a project that otherwise implements a cookie/tracking consent banner is the finding, not merely a missing UI polish item.
- [ ] Deletion refusal names the reason: `find_symbol` the deletion handler's refusal branch (a legal-hold, active-subscription, or fraud-prevention exception) and read whether it records or returns which exception applied, versus silently no-op'ing the request with no trace of why. CCPA/CPRA requires a business to state which statutory exception it is relying on when it declines a deletion request.

## Boundaries

- [ ] Jurisdiction: `search_code` region or data-residency configuration and cloud provider region settings — a stated region is a pass; an unstated one is `undetermined`, not compliant.
- [ ] Test/staging holding real PII: reuse the fixture probe from Egress, and additionally `search_code` seed scripts for signs of copying from production — `pg_dump`, `mysqldump`, `cp prod`, a script name containing `prod` or `production`.
- [ ] Debug and admin tooling that displays personal data: `find_symbol` the admin route or debug endpoint, confirm an auth-middleware call guards it, and `search_code` for an audit-log call on the same path — display without an audit trail is the finding even when access control is present.

## Out of static reach

- Whether a third party actually honours a deletion or consent-withdrawal request once data has left this codebase — the contract may say so; the repo cannot prove compliance.
- Whether a DSAR/export response is actually transmitted through a secure channel (encrypted email, secure transfer, a dedicated portal) versus plaintext — the handler's code shows what it constructs, not how it was delivered at runtime; email and out-of-band delivery channels stay out of reach regardless.
- Statutory response-time compliance (GDPR's one-month/extendable-to-three window, CCPA's 15-business-day opt-out window) — these are process SLAs, not code properties; a handler existing says nothing about whether it runs in time.
- Real backup-restore behaviour: whether restoring an old backup resurrects data a user had deleted. This needs a live restore, not a reading of the backup job's code.
- Infrastructure-level logs outside this repo — load balancer access logs, CDN logs, cloud provider audit trails — that may carry PII in URLs or headers the application code never sees.
- Whether staging or test data is *actually* real personal data, versus merely shaped like it. The fixture and seed-script probes above find the shape; confirming the content needs a live database read.
- User-perceived clarity of consent language and UI — whether a real user would understand what they agreed to. That is a comprehension question, not a static one.
- Whether an LLM provider actually honours a stated no-train/no-retention setting — this module can show the flag was set, not that the provider complied.
- Whether a field's legal sensitivity classification is complete for every jurisdiction a real user could be in — this module checks against the frameworks the repo itself references, not every possible statute.
- Whether consent language, once confirmed to exist and be enforced, is legally valid consent under the applicable regime — this module confirms consent is recorded and checked, not that its wording clears the bar.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl` | Transport scheme (`https` vs `http`) of an API- or download-triggered DSAR/export response | High |
| `network.jsonl` + `steps.md` | A third-party tracking/analytics request fires before the consent banner is interacted with | High |
| `network.jsonl` | A cookie with a lifetime beyond the session is set before consent is granted | High |
| `screenshots/` + `final-state.md` | Opt-out/GPC signal toggled produces no visible confirmation state in the UI | Medium |

## Severity guidance

| Situation | Severity |
|---|---|
| Personal data in error reports or logs sent to a third party | High |
| Real personal data in a non-production environment or a test fixture | High |
| Deletion that misses stores the inventory lists | High |
| Personal data interpolated into a third-party prompt with no notice | High |
| No retention limit on a store of personal data | Medium |
| Personal data used in a URL or as a key | Medium |
| Field collected but never read | Medium |
| Deletion refusal with no recorded statutory exception | Medium |
| Opt-out/GPC signal received with no visible confirmation | Medium |
| Consent withdrawal not propagated downstream | Medium |
| Precision higher than the purpose requires | Low |
| Tracking/consent-gated SDK reachable with no consent-check conditional in the path (`trace_path`) | High |
| Logged inventoried field traced (`find_callers`) to not actually be wrapped by the redaction helper | High |
| Front-end control pre-selects a marketing/data-sharing opt-in, regardless of the backend default | Medium |
| LLM call site missing a documented no-training/zero-retention flag for an inventoried field | Medium |
| Secret or literal inventoried PII hardcoded into an LLM system/developer prompt template | High |
