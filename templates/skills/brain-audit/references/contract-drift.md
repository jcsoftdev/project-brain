# Contract Drift

Gate: OpenAPI, GraphQL, protobuf, or shared types were detected.

A contract is a promise written in two or more places. This module checks whether those places still agree. Drift here is invisible to every party individually — each side is internally consistent, and the mismatch only appears in production.

**Find every representation of the contract first.** Typically: the schema artefact, the server implementation, the generated client, the consumer's own types, the documentation, and the test fixtures. Each one is a place drift can hide.

## Schema vs. server

- [ ] Every operation in the schema exists in the implementation. `search_code` the operation name, then `find_symbol` on the handler.
- [ ] Every implemented operation appears in the schema — `search_code` the route-registration/resolver list for operation names, then `search_code` each name against the schema file. A name present only on the server side is an undocumented endpoint, drift plus a `Reachability` question.
- [ ] Field-level agreement: names, types, nullability, required-ness, enum members — `find_symbol` the schema type and the implementation's corresponding type/model, and diff the field lists by hand. Nullability drift is the most commonly missed and the most likely to crash a consumer.
- [ ] Declared error responses match what the server actually returns, including status codes — `search_code` the status codes and error shapes thrown in the handler, then compare against the schema's documented responses for the same operation.
- [ ] The schema is generated from the implementation or verified against it — `search_code` the manifest/CI config for a codegen or schema-validation step (`openapi-generator`, `graphql-codegen`, a schema-diff check). None found means a hand-maintained schema with no check, which will drift — that is not a prediction, it is a certainty.
- [ ] For streaming operations (Server-Sent Events, JSON Lines, multipart/mixed — expressible in OpenAPI 3.2+ via `itemSchema`), the declared per-event shape matches what the handler actually emits. `search_code` the handler's stream-write calls and diff the emitted event shape against the schema's `itemSchema`. A schema still describing the operation as a single response body — the only option before 3.2 — while the implementation already streams typed events is drift the older schema shape cannot even express, not merely an outdated field.

## Schema vs. consumer

- [ ] Generated clients are regenerated from the current schema, and the generated output is either committed or built in CI — `search_code` the CI config for the client-generation command and check whether the generated directory is `.gitignore`d (built fresh) or committed (needs a staleness check). A stale committed client is drift with a long fuse.
- [ ] Hand-written consumer types match the schema. Cross-reference `api.md`: `find_callers` on the response type to see who destructures which fields, then diff those field names against the schema.
- [ ] Consumers do not read fields the schema does not promise — `search_code` the destructuring/property-access sites on a response object and check each accessed field appears in the schema, including fields that happen to exist today but are undocumented.
- [ ] Consumers tolerate fields being added — `search_code` for a strict/`.strict()` parsing mode or a validator configured to reject unknown keys on incoming responses. A client rejecting unknown fields makes every additive change breaking.

## Versioning of the contract

- [ ] Schema changes are classified as additive or breaking, and breaking ones are versioned — `search_code` for a schema version field or a CHANGELOG referencing the schema. Cross-reference `versioning-compatibility.md`.
- [ ] These look additive and are not: narrowing a type, adding a required field, making an optional field required, removing an enum member, tightening a pattern — read the schema file's recent git history (`git log -p` on the schema path) and check each change against this list.
- [ ] For protobuf: field numbers are never reused or renumbered, removed fields are reserved — read the `.proto` file, list every field number in the message, and confirm no gap in the sequence is unaccounted for by a `reserved` statement.
- [ ] For GraphQL: removing a field or changing a type is breaking even when clients do not currently request it — read the schema file's git history for removed fields or changed types; someone's query will break even if none in this repo does.

## Shared types across boundaries

- [ ] Types shared between packages or services come from one source, not duplicated definitions kept in sync by hand — `search_code` the type name; if it is declared, not imported, in more than one package, that is a duplicate rather than a shared type.
- [ ] Where duplication is unavoidable, a test asserts equivalence — `search_code` the test suite for an assertion comparing the two duplicated definitions field-by-field. Same anti-drift pattern as a manifest-parity test: the hand-maintained copy is fine, the unguarded hand-maintained copy is not.
- [ ] Serialisation boundaries agree on representation — date encoding, number precision, null vs. absent, empty vs. missing — read the serializer on one side and the deserializer on the other for the same field and compare what each assumes.
- [ ] Enum values agree on the wire, not only in name — `find_symbol` both enum definitions and diff their underlying string/numeric values, not just the member names.

## Fixtures and tests

- [ ] Test fixtures are validated against the schema — `search_code` test setup for the fixture being passed through the schema's own parser/validator before use. A fixture that drifted from the contract makes the suite pass against a shape that no longer exists, and the tests then actively hide the drift.
- [ ] Contract tests exist at the boundary, not only unit tests on each side — `search_code` for a contract-testing tool: a Pact consumer test producing a `*.pact.json`/`pacts/` artefact plus a provider-side verification step that replays it (from disk or a Pact Broker), a Spring Cloud Contract stub, or a shared fixture package consumed by both producer and consumer — versus tests that only exercise one side in isolation. Two sides each passing their own tests is exactly the state in which drift survives; a pact file with no matching provider-verification step in CI is half the mechanism, and behaves like having none.
- [ ] Something in CI fails when the schema and the implementation disagree — `search_code` the CI workflow files for a schema-diff, contract-test, or codegen-verification step. If not, that missing check is the finding that generates all the others.

## Out of static reach

- Whether a consumer outside this repo — a mobile app, a partner integration — reads a field this module cannot see.
- Runtime behaviour when a field the schema promises is actually absent on the wire under a server-side conditional this audit didn't trace.
- Whether a client's "tolerant" handling of extra fields is truly forward-compatible, or merely untested against a field's removal.
- The provider's actual current schema version, when the local copy is unpinned — this module reads what's committed, not what production serves.
- The historical intent behind an intentionally undocumented endpoint (internal-only, deprecated-but-kept) versus true drift.

## Severity guidance

| Situation | Severity |
|---|---|
| Consumer reads a field the server no longer returns | Critical |
| Nullability mismatch between schema and implementation | High |
| Breaking schema change shipped as additive | High |
| Protobuf field number reused or renumbered | High |
| Stale committed generated client | High |
| Test fixtures drifted from the schema, hiding the mismatch | High |
| Operation implemented but absent from the schema | Medium |
| Declared error responses that do not match reality | Medium |
| Duplicated shared types with no equivalence test | Medium |
| No CI check that schema and implementation agree | Medium |
| Streaming event shape drifted from the declared `itemSchema` | Medium |
| Pact file with no provider-side verification wired into CI | Medium |
| Client rejecting unknown fields | Low |
