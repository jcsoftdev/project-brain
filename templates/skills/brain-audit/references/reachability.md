# Reachability

Is this code reachable at all? This module runs on the call graph, so it answers with certainty where a grep-based auditor can only guess.

**Before reporting anything here as dead, rule out** — and state which you ruled out: public API surface, dynamic dispatch, reflection, string-keyed registries, framework-convention entry points (route files, migrations, plugin folders), test-only usage, and cross-repo consumers. `find_callers` returning empty means *no in-repo caller*, nothing more.

## Dead exports

- [ ] For each exported symbol, `find_callers`. Empty ⇒ candidate. Cross-check against the exclusion list above before reporting.
- [ ] `impact` on each candidate to confirm the blast radius is genuinely zero — a symbol with no direct callers but a live transitive path is not dead.
- [ ] Whole modules whose every export is unreferenced — `find_callers` on each export in the module; if all come back empty, `find_symbol` the module's own barrel/index file to confirm nothing re-exports it either. These are the cheap, high-value deletions.
- [ ] Types, interfaces, and enums declared and never referenced — `find_callers` on the type name where the indexer tracks type references; otherwise `search_code` the bare identifier and rule out matches inside comments or string literals before counting a hit.

## Dead endpoints

- [ ] Every server route / handler: does any client in the repo call it? `search_code` the path literal, then `trace_path` from the client call site to the handler.
- [ ] Routes registered but never mounted, or mounted behind a router nobody attaches — `find_callers` on the router-registration call itself (`app.use(router)`, `router.register(...)`); zero callers means every route inside it never sees traffic, regardless of what each one looks like individually.
- [ ] The inverse: a client calling a path that no handler serves — `search_code` the path string at client/fetch call sites, then `find_symbol` for a matching route definition. No match on the server side is the finding. This is `High` — it fails in production, not at build.

## Unreachable branches

- [ ] Conditions that cannot be true: checks after an early return, mutually exclusive guards, `if (x)` where `x` is a constant — read the guard chain at the cited `file:line` and confirm the earlier branch already excludes this one.
- [ ] Feature flags permanently off — `search_code` the flag key; if the default is `false` and no config file, CLI flag, or admin surface in the repo ever sets it `true`, the gated code is dead until someone flips it, and nobody remembers it exists.
- [ ] Environment variables read by code but set by no `.env.example`, no CI config, no Dockerfile, no docs — `search_code` the variable name across those four locations. A hit nowhere means the fallback path is the only path that ever runs.
- [ ] Catch blocks for exceptions the try block cannot raise — read the try body at the cited lines; if nothing inside it can throw the caught type, or cannot throw at all, the catch is dead code hiding a wrong assumption.

## Declared but unused

Sweep each category and report the orphans:

- [ ] Assets — images, fonts, icons, static files referenced by nothing — `search_code` the filename, without extension, to also catch dynamic path construction, across templates, components, and stylesheets. Zero hits is an orphan.
- [ ] i18n keys present in locale files, referenced by no call site — `search_code` the key string against the translation call (`t(`, `i18n.t(`, `useTranslation`); defer depth to the `i18n` module if it is in the confirmed set.
- [ ] Environment variables declared in `.env.example` / config schema, read by nothing — `search_code` the variable name in application source; a hit only inside the example file means it is declared and dead.
- [ ] Config options accepted by the parser, consumed by nothing — `find_callers` on the field access (`config.optionName`); empty means the option is parsed and then ignored.
- [ ] Dependencies in the manifest, imported by nothing — `search_code` the package name as an import specifier (defer licensing depth to `dependencies-licensing.md`).
- [ ] Database columns, indexes, and tables that no query touches — `search_code` the column/table name across query builders, ORM models, and raw SQL.

## Used but never declared — the inverse gap

**This is the check almost nobody runs, and it is where the expensive bugs hide.** The declared-but-unused direction wastes bytes; this direction breaks at runtime.

- [ ] Environment variables read in code but declared in no `.env.example`, schema, or deployment manifest — `search_code` the variable name in source, then confirm its absence from those three locations with the same search. Works on the author's machine, `undefined` in production.
- [ ] i18n keys referenced by call sites but missing from one or more locale files — `search_code` the key literal against every locale file; a key present in the default locale and absent from another is the finding — the missing locale renders the raw key to a user.
- [ ] Asset paths built at runtime (string concatenation, template literals) pointing at files that do not exist — `search_code` the template-literal fragment (e.g. `` `/icons/${ ``) and check the resolved directory for each value it can actually interpolate.
- [ ] Code reading a database column that no migration creates — `search_code` the column name in query/model code, then confirm no migration file declares it.
- [ ] Imports of packages absent from the manifest — `search_code` the import specifier, then check the manifest; a match with no manifest entry is resolved today only by a transitive hoist that the next lockfile update will remove.
- [ ] Config keys consumed by code but rejected or ignored by the config parser — `find_symbol` the parser/schema definition and diff its accepted keys against every `config.<key>` access site `search_code` returns.

## Out of static reach

- Dynamic dispatch through a string-keyed registry whose key is computed at runtime (config-driven plugin loading) — reachable in practice, invisible to the call graph.
- Code loaded through `eval`, a database-stored script, or a plugin fetched at runtime.
- Whether a branch this module calls dead is actually exercised by a remote feature-flag value never committed to the repo.
- An exported symbol with zero in-repo callers that is the published API surface for a separate downstream repo this audit cannot see.
- Whether an undeclared env var is supplied by infrastructure-as-code, a secrets manager, or a platform dashboard outside version control.

## Severity guidance

| Situation | Severity |
|---|---|
| Client calls an endpoint that does not exist | Critical / High |
| Code reads an env var or column nothing provides | High |
| Feature flag permanently off, gating shipped code | Medium |
| Exported symbol with zero callers, exclusions ruled out | Medium |
| Unused asset, dependency, or locale key | Low |
| Declared-and-unused type or config option | Info / Low |
