# Privacy

Gate: personal data or user data is persisted.

Distinct from `Security`, which asks whether data can be stolen. This module asks whether the system should have the data at all, whether it goes places nobody intended, and whether the user can get it out or get it deleted.

## Inventory first

You cannot audit what you have not enumerated. Build the list before checking anything.

- [ ] Every field that identifies or describes a person: name, email, phone, address, IP, device id, precise location, government id, payment details, biometrics, health, and anything derived from these.
- [ ] Free-text fields count. A "notes" column collects whatever users type, including data nobody designed for.
- [ ] For each field record: where it enters, where it is stored, where it is sent, how long it is kept.
- [ ] Note fields collected but never read — cross-reference `Reachability`. Data collected for no purpose is the easiest privacy finding to fix: stop collecting it.

## Egress — where does it go

- [ ] Every third party that receives personal data: analytics, error reporting, logging, LLM providers, support tools, CDNs.
- [ ] **Error reports and logs are the most common accidental egress.** Check what is attached to an exception — request bodies, headers, user objects.
- [ ] **Prompts are egress.** If personal data is interpolated into an LLM call, that data left the system. Cross-reference `ai.md`.
- [ ] Client-side scripts that can read personal data from the page or from storage.
- [ ] Backups, exports, and fixtures — a production dump used as a test fixture is a leak. `search_code` test fixtures for real-looking emails and names.

## Minimisation

- [ ] Each field has a purpose that someone can state. If nobody can, that is the finding.
- [ ] Precision is no higher than needed — a year instead of a birth date, a region instead of coordinates.
- [ ] Identifiers are pseudonymous where the real identity is not needed downstream.
- [ ] Personal data is not used as a key or in a URL where it will end up in logs, referrers, and browser history.

## Retention and deletion

- [ ] Every store of personal data has a retention period, and something actually enforces it. A policy with no job is not a policy.
- [ ] Deletion is real and complete: primary tables, related rows, caches, search indexes, blob storage, backups, and third parties. `find_callers` on the delete path and check each store the inventory listed.
- [ ] Soft delete is not presented to the user as deletion.
- [ ] Logs containing personal data have a shorter retention than the logs' default, or do not contain it.

## User rights

- [ ] Export exists and returns everything the inventory lists, not just the profile table.
- [ ] Deletion is requestable and its scope is stated.
- [ ] Consent, where required, is recorded with what was consented to and when — and withdrawal is honoured downstream, including at third parties.
- [ ] Defaults are the privacy-preserving option.

## Boundaries

- [ ] Data crossing a jurisdiction is deliberate and documented.
- [ ] Test, staging, and development environments do not hold real personal data. If they do, that is `High` — those environments have weaker access control by design.
- [ ] Debug and admin tooling that displays personal data is access-controlled and audited.

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
| Consent withdrawal not propagated downstream | Medium |
| Precision higher than the purpose requires | Low |
