# Type Safety

Does the type checker actually check anything? Gate: a statically or gradually typed language was detected.

A type checker is only as strong as the code's willingness to obey it. This module audits the escape hatches — the places where a codebase declares itself typed and then opts out — not the types themselves. It does not review type design, generics, or variance; that is a code-quality concern for `consistency.md`. And a language with a type checker configured is table stakes here: **a typed language with no checker configured at all is the headline finding**, reported once, before any of the checks below.

## Establish the baseline first

- [ ] Locate the checker config: `search_code` for `tsconfig.json`, `mypy.ini`, `pyrightconfig.json`, `go.mod` (Go's checker is the compiler itself, not opt-in), `.flowconfig`. Record which strictness flags are actually set — `strict`, `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` for TypeScript; `strict = True`, `disallow_untyped_defs`, `warn_return_any`, `warn_unreachable` for mypy. **Check the TypeScript major version first** (`package.json`): TypeScript 6.0 (March 2026) flipped `strict`'s default from `false` to `true` when the field is unset, and TypeScript 7.0 (July 2026, the native Go-ported compiler — current as of this writing) hardens that into a locked-in default. On TypeScript ≥6, an *absent* `strict` field means strict is already on — the finding worth chasing on a current project is an explicit `"strict": false` or a per-flag override that turns a strict-bundled check back off, not the field's absence. On TypeScript <6, absence still means unstrict, as this module originally assumed.
- [ ] `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are never implied by `strict: true`, on any TypeScript version — both must be opted into individually. `noUncheckedIndexedAccess` adds `| undefined` to indexed-access results (`obj[key]` stops pretending the key is guaranteed present); `exactOptionalPropertyTypes` stops treating an omitted optional property the same as one explicitly set to `undefined`. Their absence from a config that otherwise looks maximally strict is a real, checkable gap, not house-style pedantry. mypy's equivalent gap is `warn_unreachable` — not included in `--strict` on any current mypy version, and the effective `--strict` flag set is documented to change between releases, so read it from the version actually pinned rather than assuming a fixed list.
- [ ] **If the language is statically or gradually typed and no checker config exists anywhere in the tree, stop here and report that as the finding.** Nothing below applies to code nobody is checking.
- [ ] A config that declares strictness but scopes it away: `exclude` covering half the source tree, a `// @ts-nocheck` at file scope, a per-directory override that relaxes the root config. Read the `include`/`exclude` arrays literally — a strict root config with a permissive override is a strict config in name only.

## Suppression directives and their density

- [ ] `search_code` for `: any`, `as any`, `@ts-ignore`, `@ts-expect-error`, `# type: ignore`, `# noqa`, `@SuppressWarnings`, `interface{}` (Go), `unknown as`, `!` non-null assertion clusters. Count occurrences and note which files concentrate them — a handful spread across a large codebase is normal drift; a third of one module is that module opting out of the type system entirely.
- [ ] Each suppression should carry a reason — a comment or a linked issue explaining *why* the checker cannot express what's true here. A bare `@ts-ignore` with no comment is a silenced error, not a documented exception; distinguish the two counts.
- [ ] `@ts-expect-error` vs `@ts-ignore` (or the mypy equivalent, a scoped `# type: ignore[code]` vs a bare one): the former fails loudly when the underlying error is fixed and the suppression becomes stale; the latter fails silently forever. A codebase using only the bare form has no mechanism to notice when a suppression outlives its cause.
- [ ] Suppressions wrapping a large block rather than one line — the broader the scope, the more real errors it can be hiding besides the one it was written for.
- [ ] `any` on an **exported/public** function's parameter or return type specifically — `find_callers` to see how far the unsafety spreads. `any` inside a private helper's body is contained; `any` on a public signature leaks to every caller and their callers, silently.
- [ ] The double-cast pattern `as unknown as X` (or `# type: ignore` immediately followed by a direct field access). A single `as X` at least has to satisfy some structural overlap with the source type; routing through `unknown` first discards that check entirely and admits the checker has nothing useful to say here.

## Boundary typing — the single most common failure

Data crossing a trust boundary — a network response, `JSON.parse`, an environment variable, a database row, form input, a webhook payload — is typed by *assertion* (`as ResponseType`, a generic type parameter on `fetch`, an unchecked cast) rather than validated at runtime. This is the gap between "the code compiles" and "the type is true." TypeScript has not closed this gap natively: its types remain fully erased at compile time on every current version, including the 7.0 Go-ported compiler — there is no first-party mechanism to check a value's shape at runtime from a `type`/`interface` declaration, so a runtime validation library is not optional tooling here, it is the only fix that exists.

- [ ] `search_code` for `as ` immediately following `JSON.parse(`, `.json()`, or an HTTP client call. An assertion here tells the checker to trust unverified bytes.
- [ ] `search_code` for a runtime validation library (`zod` — v4 current, tree-shakeable imports — `io-ts`, `pydantic` — v2 current, Rust core — `class-validator`, `ajv`) and check whether it is actually applied at every boundary, or only at some of them — a `zod` schema imported by three of eight route handlers is five unvalidated ones. Also check the schema isn't overloaded with domain rules beyond parsing/shape validation — current practice keeps boundary validation and business-logic validation as separate steps, so a schema that half-does both is harder to audit for boundary coverage.
- [ ] Environment variable access (`process.env.X`, `os.environ[...]`) typed as a non-optional string with no runtime check that it was actually set. The type says `string`; the runtime value can be `undefined`.
- [ ] ORM query results whose row type is generated from the schema but whose *nullability* doesn't reflect an actual `LEFT JOIN` or optional relation in that specific query — the generated type is correct for the general case and wrong for this call site.
- [ ] Generic type parameters on an HTTP client (`fetch<User>(...)`, `axios.get<User>(...)`) with no corresponding runtime check — this is an assertion wearing generic syntax, not a guarantee.
- [ ] Route/query parameters typed as a narrow literal union (`'asc' | 'desc'`) but read from `req.query`/`req.params` with a bare cast rather than a runtime check — the URL can carry any string, and the type only describes the values the author expected, not the values a client can actually send.

## Lint-level escape hatches

- [ ] Lint rules that would catch unsafe patterns (`@typescript-eslint/no-explicit-any`, `@typescript-eslint/no-unsafe-assignment`, `flake8` type-adjacent rules) disabled at the config root versus disabled per-line. A root-level disable is a policy decision; per-line disables should each carry the same reasoning bar as a suppression directive above.
- [ ] The disable comment's scope: `/* eslint-disable */` for a whole file silences everything after it, including future violations nobody intended to allow.

## Generated types

- [ ] Types generated from an external source — an OpenAPI spec, a GraphQL schema, a database schema, protobuf — are actually regenerated in CI or on a documented trigger, not hand-edited after generation. `search_code` for the generation command in CI config; its absence means the committed types are a snapshot, not a contract. Cross-reference `contract-drift.md`, which owns whether the generated types still match the source of truth — this module only asks whether generation itself is live or has silently become manual.
- [ ] Hand-edits inside a file whose header says "auto-generated, do not edit" — `search_code` the generated-file banner text, then check for local modifications. The next regeneration silently reverts them.

## Test-time type erosion

- [ ] Mocks and test doubles typed as `any` or with a partial/loose shape rather than satisfying the real interface. A production interface change that should break a test compile-time instead breaks nothing, because the mock never had to agree with the real type in the first place — the very place a type error would be cheapest to catch is where it's silenced.

## Out of static reach

- Whether a runtime validator's schema is actually kept in sync with the static type it's meant to justify — that's a manual diff, not a probe.
- Whether a suppression's stated reason is still true today.
- Runtime type errors that never surface as a thrown exception (silent coercion, e.g. JS implicit `NaN` propagation).
- The actual JS/Python values flowing through an `any`/`Any`-typed path in production.

## Severity guidance

| Situation | Severity |
|---|---|
| No type checker configured for a typed language | High |
| Boundary data trusted via assertion instead of runtime validation | High |
| Root-level suppression scope covering most of the source tree | High |
| Generated types no longer regenerated, drifting silently | Medium |
| Hand-edits inside a file marked auto-generated | Medium |
| Suppression directive with no reason and no expiry mechanism | Medium |
| Lint rule disabled globally rather than at the violating line | Medium |
| Dense cluster of suppressions in one module | Medium |
| Isolated, justified suppression with a linked reason | Low |
| `@ts-expect-error` used correctly (fails when stale) | Info |
