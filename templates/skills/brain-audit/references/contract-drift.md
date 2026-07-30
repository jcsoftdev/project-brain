# Contract Drift

Gate: OpenAPI, GraphQL, protobuf, or shared types were detected.

A contract is a promise written in two or more places. This module checks whether those places still agree. Drift here is invisible to every party individually — each side is internally consistent, and the mismatch only appears in production.

**Find every representation of the contract first.** Typically: the schema artefact, the server implementation, the generated client, the consumer's own types, the documentation, and the test fixtures. Each one is a place drift can hide.

## Schema vs. server

- [ ] Every operation in the schema exists in the implementation. `search_code` the operation name, then `find_symbol` on the handler.
- [ ] Every implemented operation appears in the schema. An undocumented endpoint is drift plus a `Reachability` question.
- [ ] Field-level agreement: names, types, nullability, required-ness, enum members. Nullability drift is the most commonly missed and the most likely to crash a consumer.
- [ ] Declared error responses match what the server actually returns, including status codes.
- [ ] The schema is generated from the implementation or verified against it. A hand-maintained schema with no check will drift — that is not a prediction, it is a certainty.

## Schema vs. consumer

- [ ] Generated clients are regenerated from the current schema, and the generated output is either committed or built in CI. A stale committed client is drift with a long fuse.
- [ ] Hand-written consumer types match the schema. Cross-reference `api.md`: `find_callers` on the response type to see who destructures which fields.
- [ ] Consumers do not read fields the schema does not promise — including fields that happen to exist today but are undocumented.
- [ ] Consumers tolerate fields being added. A client that rejects unknown fields makes every additive change breaking.

## Versioning of the contract

- [ ] Schema changes are classified as additive or breaking, and breaking ones are versioned. Cross-reference `versioning-compatibility.md`.
- [ ] These look additive and are not: narrowing a type, adding a required field, making an optional field required, removing an enum member, tightening a pattern.
- [ ] For protobuf: field numbers are never reused or renumbered, removed fields are reserved, and required-ness changes are treated as breaking.
- [ ] For GraphQL: removing a field or changing a type is breaking even when clients do not currently request it — someone's query will.

## Shared types across boundaries

- [ ] Types shared between packages or services come from one source, not duplicated definitions kept in sync by hand.
- [ ] Where duplication is unavoidable, a test asserts equivalence. Same anti-drift pattern as a manifest parity test: the hand-maintained copy is fine, the unguarded hand-maintained copy is not.
- [ ] Serialisation boundaries agree on representation — date encoding, number precision, null vs. absent, empty vs. missing.
- [ ] Enum values agree on the wire, not only in name.

## Fixtures and tests

- [ ] Test fixtures are validated against the schema. A fixture that drifted from the contract makes the suite pass against a shape that no longer exists — the tests then actively hide the drift.
- [ ] Contract tests exist at the boundary, not only unit tests on each side. Two sides each passing their own tests is exactly the state in which drift survives.
- [ ] Something in CI fails when the schema and the implementation disagree. If not, that missing check is the finding that generates all the others.

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
| Client rejecting unknown fields | Low |
