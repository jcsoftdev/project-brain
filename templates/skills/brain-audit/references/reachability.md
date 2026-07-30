# Reachability

Is this code reachable at all? This module runs on the call graph, so it answers with certainty where a grep-based auditor can only guess.

**Before reporting anything here as dead, rule out** — and state which you ruled out: public API surface, dynamic dispatch, reflection, string-keyed registries, framework-convention entry points (route files, migrations, plugin folders), test-only usage, and cross-repo consumers. `find_callers` returning empty means *no in-repo caller*, nothing more.

## Dead exports

- [ ] For each exported symbol, `find_callers`. Empty ⇒ candidate. Cross-check against the exclusion list above before reporting.
- [ ] `impact` on each candidate to confirm the blast radius is genuinely zero — a symbol with no direct callers but a live transitive path is not dead.
- [ ] Whole modules whose every export is unreferenced. These are the cheap, high-value deletions.
- [ ] Types, interfaces, and enums declared and never referenced.

## Dead endpoints

- [ ] Every server route / handler: does any client in the repo call it? `search_code` the path literal, then `trace_path` from the client call site to the handler.
- [ ] Routes registered but never mounted, or mounted behind a router nobody attaches.
- [ ] The inverse: a client calling a path that no handler serves. This is `High` — it fails in production, not at build.

## Unreachable branches

- [ ] Conditions that cannot be true: checks after an early return, mutually exclusive guards, `if (x)` where `x` is a constant.
- [ ] Feature flags permanently off — flag read in code, default `false`, never set anywhere. The gated code is dead until someone flips it, and nobody remembers it exists.
- [ ] Environment variables read by code but set by no `.env.example`, no CI config, no Dockerfile, no docs. The fallback path is the only path that ever runs.
- [ ] Catch blocks for exceptions the try block cannot raise.

## Declared but unused

Sweep each category and report the orphans:

- [ ] Assets — images, fonts, icons, static files referenced by nothing.
- [ ] i18n keys present in locale files, referenced by no call site (defer depth to the `i18n` module if it is in the confirmed set).
- [ ] Environment variables declared in `.env.example` / config schema, read by nothing.
- [ ] Config options accepted by the parser, consumed by nothing.
- [ ] Dependencies in the manifest, imported by nothing (defer licensing depth to `dependencies-licensing.md`).
- [ ] Database columns, indexes, and tables that no query touches.

## Used but never declared — the inverse gap

**This is the check almost nobody runs, and it is where the expensive bugs hide.** The declared-but-unused direction wastes bytes; this direction breaks at runtime.

- [ ] Environment variables read in code but declared in no `.env.example`, schema, or deployment manifest. Works on the author's machine, `undefined` in production.
- [ ] i18n keys referenced by call sites but missing from one or more locale files — the missing locale renders the raw key to a user.
- [ ] Asset paths built at runtime (string concatenation, template literals) pointing at files that do not exist.
- [ ] Code reading a database column that no migration creates.
- [ ] Imports of packages absent from the manifest — resolved today only by a transitive hoist that the next lockfile update will remove.
- [ ] Config keys consumed by code but rejected or ignored by the config parser.

## Severity guidance

| Situation | Severity |
|---|---|
| Client calls an endpoint that does not exist | Critical / High |
| Code reads an env var or column nothing provides | High |
| Feature flag permanently off, gating shipped code | Medium |
| Exported symbol with zero callers, exclusions ruled out | Medium |
| Unused asset, dependency, or locale key | Low |
| Declared-and-unused type or config option | Info / Low |
