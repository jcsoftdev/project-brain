# Privacy

Gate: personal data or user data is persisted.

Distinct from `Security`, which asks whether data can be stolen. This module asks whether the system should have the data at all, whether it goes places nobody intended, and whether the user can get it out or get it deleted.

## Inventory first

You cannot audit what you have not enumerated, and unlike most modules in this skill, the inventory here is not inference — **the schema's field names are the probe, and they are already sitting in plain text.** Read them literally before doing anything else; every later section reuses this list rather than rediscovering fields case by case.

- [ ] `search_code` schema, model, and migration files (or `get_module` on the data-layer module) and read every column and field name against a checklist: name, email, phone, address, IP, device id, precise location / lat / lng, government id, payment or card details, biometrics, health, date of birth — and anything a foreign key derives from these. This single pass is the inventory; do not skip it and guess later. The two-tier split — ordinary identifiers versus the higher-sensitivity group (government id, payment details, biometrics, health) — follows NIST SP 800-122's PII / "sensitive PII" distinction; treat a hit in the sensitive group as the stronger finding when the same gap (no stated purpose, no retention limit) applies to both.
- [ ] Free-text columns count and cannot be enumerated by name alone — `search_code` for columns named `notes`, `comment`, `bio`, `description`, `message`, `feedback`. Flag each as "unbounded content, requires manual read of sample call sites" rather than pretending the column name tells you what is inside it.
- [ ] For each inventoried field, trace its lifecycle: `find_callers` on its accessor to see where it is read, `trace_path` from the API input that sets it to the write that persists it. Where it enters, where it lands, and what touches it in between is the row this checklist is actually building.
- [ ] Collected-but-never-read fields are the cheapest finding in this module. `find_callers` on the read path for the column — empty, with `Reachability`'s exclusions in `reachability.md` ruled out, means it is a candidate. Stop collecting it rather than justifying it.

## Egress — where does it go

- [ ] Enumerate third parties first: `get_architecture` dependencies plus `search_code` for known SDK imports — analytics, error reporting, logging platforms, LLM providers, support-tool SDKs, CDNs. A third party you have not named cannot be checked.
- [ ] **Error reports and logs are the most common accidental egress.** `search_code` the error-reporting SDK's capture call (`Sentry.captureException`, `.captureMessage`, or equivalent) and read literally what is passed — a scrubbed error object, or the full request with headers and body attached.
- [ ] **Prompts are egress.** `search_code` the LLM SDK call site and read what is interpolated into the messages/prompt argument against the field inventory above — if an inventoried field lands there, that data left the system. Cross-reference `ai.md`.
- [ ] Client-side scripts that read personal data from the page or from storage: `search_code` `localStorage`/`sessionStorage`/cookie reads adjacent to an analytics `track()`/`identify()` call — the adjacency is what makes it egress rather than a UI convenience.
- [ ] Backups, exports, and fixtures — `search_code` test fixtures and seed files for realistic-looking emails and names. **Rule out first:** `example.com`, `test@test.com`, and obviously synthetic names (`Jane Doe`, `Test User`) are not the finding. A fixture using a real corporate domain, or a name that resolves to an actual person, is — confirm which one you are looking at before reporting it.

## Minimisation

- [ ] "Each field has a stated purpose" is not checked field-by-field on suspicion — walk the inventory list and, for each entry, look for a comment, schema doc, or data dictionary stating why it is collected. Report the absence once, across the whole inventory, with the count of fields with no stated purpose — not as N separate findings.
- [ ] Precision: read the field's declared type against what the feature needs — a `timestamp` where a year would do, a `lat`/`lng` pair where a region would do. The schema states the precision directly; no inference needed.
- [ ] Pseudonymous where possible: `search_code` whether downstream tables and services key on the real PII field (email, phone) directly, or on an internal id that only resolves to PII at one boundary.
- [ ] PII in a URL or in logs: `search_code` route definitions for path parameters shaped like `:email`, `:phone`, `/user/:name`, and logger call sites that would capture a query string carrying one of the inventoried fields.

## Retention and deletion

- [ ] Retention enforced, not just declared: for each store the inventory names, `search_code` for a scheduled job, cron entry, or TTL index tied to it. A store with no matching job is a policy with no enforcement — report it as such, don't assume one exists off-repo.
- [ ] Deletion completeness is a diff, not a guess: `find_callers` on the account/data-deletion handler, then `find_callees` to enumerate every store it actually touches. The gap between that set and the full inventory from the first section is the finding — name the stores deletion misses.
- [ ] Soft delete: `find_symbol` the delete function and read its body — does it set a flag/mark a row, or actually remove or anonymise it? Then check whether user-facing copy (`search_code` the confirmation string) calls this "delete" when it is really a flag flip.
- [ ] Log retention: `search_code` the logging platform's retention or TTL configuration and compare it against how long the inventoried fields persist elsewhere — a log line living longer than the record it was copied from is the finding.

## User rights

- [ ] Export completeness: `find_symbol` the export/data-download handler, `find_callees` from it, and compare the fields it actually serialises against the full inventory — a data export returning the profile table only, while the inventory lists five other stores, is the finding, named field by field.
- [ ] Deletion requestable: `search_code` for a deletion-request endpoint, or its documented process if the flow is manual (support ticket, admin action) — either counts, but one of them must exist and be discoverable from the code.
- [ ] Consent recorded: `search_code` the schema for a `consent`/`consented_at`-shaped column, then `find_callers` on it to confirm it is actually checked before the gated use, not merely written and ignored.
- [ ] Defaults: read the signup or settings handler for a data-sharing/marketing flag and its default value in the schema or the handler's initial-state literal — defaulting to opted-in is the finding.
- [ ] Opt-out signal handling: `search_code` for `Sec-GPC` or Global Privacy Control handling and, where present, trace whether it drives a visible confirmation state (an "opt-out honoured" indicator) rather than only a silent internal flag flip — CCPA/CPRA requires the confirmation be visible to the user, effective 2026-01-01. Its total absence in a project that otherwise implements a cookie/tracking consent banner is the finding, not merely a missing UI polish item.
- [ ] Deletion refusal names the reason: `find_symbol` the deletion handler's refusal branch (a legal-hold, active-subscription, or fraud-prevention exception) and read whether it records or returns which exception applied, versus silently no-op'ing the request with no trace of why. CCPA/CPRA requires a business to state which statutory exception it is relying on when it declines a deletion request.

## Boundaries

- [ ] Jurisdiction: `search_code` region or data-residency configuration and cloud provider region settings — a stated region is a pass; an unstated one is `undetermined`, not compliant.
- [ ] Test/staging holding real PII: reuse the fixture probe from Egress, and additionally `search_code` seed scripts for signs of copying from production — `pg_dump`, `mysqldump`, `cp prod`, a script name containing `prod` or `production`.
- [ ] Debug and admin tooling that displays personal data: `find_symbol` the admin route or debug endpoint, confirm an auth-middleware call guards it, and `search_code` for an audit-log call on the same path — display without an audit trail is the finding even when access control is present.

## Out of static reach

- Whether a third party actually honours a deletion or consent-withdrawal request once data has left this codebase — the contract may say so; the repo cannot prove compliance.
- Whether a DSAR/export response is actually transmitted through a secure channel (encrypted email, secure transfer, a dedicated portal) versus plaintext — the handler's code shows what it constructs, not how it was delivered at runtime.
- Statutory response-time compliance (GDPR's one-month/extendable-to-three window, CCPA's 15-business-day opt-out window) — these are process SLAs, not code properties; a handler existing says nothing about whether it runs in time.
- Real backup-restore behaviour: whether restoring an old backup resurrects data a user had deleted. This needs a live restore, not a reading of the backup job's code.
- Infrastructure-level logs outside this repo — load balancer access logs, CDN logs, cloud provider audit trails — that may carry PII in URLs or headers the application code never sees.
- Whether staging or test data is *actually* real personal data, versus merely shaped like it. The fixture and seed-script probes above find the shape; confirming the content needs a live database read.
- User-perceived clarity of consent language and UI — whether a real user would understand what they agreed to. That is a comprehension question, not a static one.

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
