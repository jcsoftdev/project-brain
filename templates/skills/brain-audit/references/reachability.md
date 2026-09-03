# Reachability

Is this code reachable at all? This module runs on the call graph, so it answers with certainty where a grep-based auditor can only guess.

**Before reporting anything here as dead, name which rule-out categories were checked and which applied** — not just that rule-outs were considered: public API surface (check the manifest's `exports`/`main`/`types` fields), dynamic dispatch (`search_code` the bare identifier as a string literal, since a registry keyed by name will not appear as a call), reflection, string-keyed registries, framework-convention entry points (route files, migrations, plugin folders), test-only usage, and cross-repo consumers. `find_callers` returning empty means *no in-repo caller*, nothing more — averaged across 13 call-graph tools, static analysis missed 61% of dynamically-executed methods (Sun et al., arXiv preprint, 2024, https://arxiv.org/abs/2407.07804), so a blanket "rule-outs considered" with no category named satisfies the letter of this requirement while missing its point.

## Dead exports

- [ ] For each exported symbol, `find_callers`. Empty ⇒ candidate. Cross-check against the exclusion list above before reporting — the same "unused export ⇒ safe to drop" inference is what Rollup's `treeshake.moduleSideEffects` performs at the bundler level, with the identical false-positive risk this exclusion list guards against (Rollup core team, official framework documentation, current, https://rollupjs.org/configuration-options/#treeshake-modulesideeffects).
- [ ] `impact` on each candidate to confirm the blast radius is genuinely zero — a symbol with no direct callers but a live transitive path is not dead.
- [ ] Whole modules whose every export is unreferenced — `find_callers` on each export in the module; if all come back empty, `find_symbol` the module's own barrel/index file to confirm nothing re-exports it either. These are the cheap, high-value deletions — webpack's own `sideEffects: false` declaration is the bundler-side version of this exact check, with the same "verify before dropping" warning: marking a package side-effect-free when it isn't "can cause serious issues" (webpack core team, official framework documentation, current, https://webpack.js.org/guides/tree-shaking/).
- [ ] In a JS/TS project, cross-check `find_callers`-empty export candidates against the package's own `sideEffects` field (`package.json`) and any `treeshake.moduleSideEffects` bundler config — `search_code` for both. A file the project itself already declares side-effect-free and `find_callers` shows unreferenced is corroborated from two independent tools (the code graph and the bundler's own static analysis); a file marked `sideEffects: true` or listed in the side-effect array despite having no callers is a signal the maintainers know something the call graph doesn't — treat it as excluded pending human confirmation, not as a stronger candidate. Refuted if the file's side-effect declaration traces to something unrelated to reachability (a bare `import './x.css'`, a global assignment) — `search_code` the file's own content before treating the mismatch as suspicious (webpack core team, official framework documentation, current, https://webpack.js.org/guides/tree-shaking/; Rollup core team, official framework documentation, current, https://rollupjs.org/configuration-options/#treeshake-modulesideeffects).
- [ ] Types, interfaces, and enums declared and never referenced — `find_callers` on the type name where the indexer tracks type references; otherwise `search_code` the bare identifier and rule out matches inside comments or string literals before counting a hit.

## Dead endpoints

- [ ] Every server route / handler: does any client in the repo call it? `search_code` the path literal, then `trace_path` from the client call site to the handler. An endpoint no in-repo client calls is exactly OWASP's "improper inventory" precondition — their worked example shows a forgotten beta/legacy host with the same functionality as production but missing a rate-limit control enabling account takeover by brute force, not just clutter (OWASP API Security Project, OWASP API Security Top 10 2023, 2023, https://owasp.org/API-Security/editions/2023/en/0xa9-improper-inventory-management/).
- [ ] Routes registered but never mounted, or mounted behind a router nobody attaches — `find_callers` on the router-registration call itself (`app.use(router)`, `router.register(...)`); zero callers means every route inside it never sees traffic, regardless of what each one looks like individually.
- [ ] The inverse: a client calling a path that no handler serves — `search_code` the path string at client/fetch call sites, then `find_symbol` for a matching route definition. No match on the server side is the finding. This is `High` at read; `trace_path` from the client call site to the mutation/handler that would have served it, proving the call sits on a state-changing path, promotes it to `Critical` once traced.

## Unreachable branches

- [ ] Conditions that cannot be true: checks after an early return, mutually exclusive guards, `if (x)` where `x` is a constant — Read the guard chain at the cited `file:line` and confirm the earlier branch already excludes this one. This is CWE-561's exact mechanism via its CWE-570/571 children, "Expression is Always False/True" (MITRE, CWE, current, https://cwe.mitre.org/data/definitions/561.html), and the JS/TS case is already automated as a shipped lint rule — ESLint's `no-unreachable` flags code after `return`/`throw`/`continue`/`break` because "unreachable statements are usually a mistake" (OpenJS Foundation / ESLint core team, official tool documentation, current, https://eslint.org/docs/latest/rules/no-unreachable).
- [ ] Feature flags permanently off — `search_code` the flag key; if the default is `false` and no config file, CLI flag, or admin surface in the repo ever sets it `true`, the gated code is dead until someone flips it, and nobody remembers it exists — Knight Capital's "Power Peg" logic was deprecated and left on the servers in exactly this dead-until-flipped state; a repurposed flag byte flipped it live on one server and cost "$460 million loss in 45-minutes" (Doug Seven, public engineering post-mortem quoting SEC Release No. 70694, 2014, https://dougseven.com/2014/04/17/knightmare-a-devops-cautionary-tale/). When the flag defaults `false` in the repo, name which remote sources were and were not checked before calling the gated code dead: a feature-flag service (LaunchDarkly/Unleash/GrowthBook-style SDK call site — `search_code` the flag key as an SDK argument), an admin/ops dashboard the repo cannot see, or infrastructure-as-code outside this repo; a hit on an SDK call site that resolves the flag remotely downgrades the finding from "dead" to "gated by config this repo cannot see." State explicitly which of these are out of static reach rather than implying the repo-only search settled the question.
- [ ] Environment variables read by code but set by no `.env.example`, no CI config, no Dockerfile, no docs — `search_code` the variable name across those four locations. A hit nowhere means the fallback path is the only path that ever runs — config-in-environment is the canonical pattern this check assumes: "config varies substantially across deploys, code does not" (Heroku / Adam Wiggins et al., The Twelve-Factor App, current, https://12factor.net/config).
- [ ] Catch blocks for exceptions the try block cannot raise — Read the try body at the cited lines; if nothing inside it can throw the caught type, or cannot throw at all, the catch is dead code hiding a wrong assumption. Rule out a catch deliberately broader than the callee's current throw surface, written as a guard against a future dependency change — state which you checked.

## Declared but unused

Sweep each category and report the orphans:

- [ ] Assets — images, fonts, icons, static files referenced by nothing — `search_code` the filename, without extension, to also catch dynamic path construction, across templates, components, and stylesheets. Zero hits is an orphan.
- [ ] i18n keys present in locale files, referenced by no call site — `search_code` the key string against the translation call (`t(`, `i18n.t(`, `useTranslation`); defer depth to the `i18n` module if it is in the confirmed set.
- [ ] Environment variables declared in `.env.example` / config schema, read by nothing — `search_code` the variable name in application source; a hit only inside the example file means it is declared and dead — the same Twelve-Factor config-in-environment assumption this module's other env-var checks rely on (Heroku / Adam Wiggins et al., The Twelve-Factor App, current, https://12factor.net/config).
- [ ] Config options accepted by the parser, consumed by nothing — `find_callers` on the field access (`config.optionName`); empty means the option is parsed and then ignored.
- [ ] Dependencies in the manifest, imported by nothing — `search_code` the package name as an import specifier (defer licensing depth to `dependencies-licensing.md`).
- [ ] Database columns, indexes, and tables that no query touches — owned by `database.md` (`search_code` the column/table name across query builders, ORM models, and raw SQL); reuse its finding, do not re-report.

## Used but never declared — the inverse gap

**This is the check almost nobody runs, and it is where the expensive bugs hide.** The declared-but-unused direction wastes bytes; this direction breaks at runtime.

- [ ] Environment variables read in code but declared in no `.env.example`, schema, or deployment manifest — `search_code` the variable name in source, then confirm its absence from those three locations with the same search. Works on the author's machine, `undefined` in production — the direction where the Twelve-Factor promise that config is "easy to change between deploys without changing any code" breaks hardest, because the variable was never wired into deploy-time config at all (Heroku / Adam Wiggins et al., The Twelve-Factor App, current, https://12factor.net/config).
- [ ] i18n keys referenced by call sites but missing from one or more locale files — owned by `i18n.md` (`search_code` the translation call, diff literal keys against each locale file); reuse its finding, do not re-report. This module keeps only the declared-but-unreferenced direction (line 32).
- [ ] Asset paths built at runtime (string concatenation, template literals) pointing at files that do not exist — `search_code` the template-literal fragment (e.g. `` `/icons/${ ``) and check the resolved directory for each value it can actually interpolate.
- [ ] Code reading a database column that no migration creates — owned by `database.md` (`search_code` the column name in query/model code, confirmed against no migration file declaring it); reuse its finding, do not re-report.
- [ ] Imports of packages absent from the manifest — `search_code` the import specifier, then check the manifest; a match with no manifest entry is resolved today only by a transitive hoist that the next lockfile update will remove — also covered by `dependencies-licensing.md`'s imported-but-not-declared check; report once.
- [ ] Config keys consumed by code but rejected or ignored by the config parser — `find_symbol` the parser/schema definition and diff its accepted keys against every `config.<key>` access site `search_code` returns.

## Out of static reach

- Dynamic dispatch through a string-keyed registry whose key is computed at runtime (config-driven plugin loading) — reachable in practice, invisible to the call graph.
- Code loaded through `eval`, a database-stored script, or a plugin fetched at runtime.
- Whether a branch this module calls dead is actually exercised by a remote feature-flag value never committed to the repo.
- An exported symbol with zero in-repo callers that is the published API surface for a separate downstream repo this audit cannot see.
- Whether an undeclared env var is supplied by infrastructure-as-code, a secrets manager, or a platform dashboard outside version control.
- Whether a module with no referenced exports is still required for its import-time side effects (e.g. `import './setup'` for global registration alone) — this module's structural probes track export usage, not import-time execution.
- Coverage-tool-measured actual dead code (lines never hit by any test or production run) — this module's probes are static graph queries; cross-reference `runtime.md` for execution-based coverage.
- Whether an npm dependency with no local import satisfies a peerDependency contract for another workspace package — this module reads import statements, not manifest-to-manifest peer constraints.
- A route reachable only through infrastructure-level routing (reverse proxy, API gateway config) not declared in this repo's own router configuration.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl` | Code or a plugin actually fetched over the wire during a confirmed flow (`eval`, a database-stored script) | Medium |
| `final-state.md` | A branch this module calls dead actually exercised by a live remote feature-flag value, reachable through the UI | High |
| `network.jsonl` | A route this module flagged dead-by-no-in-repo-caller is actually reached through the UI (a client built dynamically — a CMS-driven nav, or a string-templated fetch URL `search_code` cannot resolve) — the route path appears as a request host+path during a confirmed flow. Refuted if the match is on path segments only (e.g. `/api/users/42` matching pattern `/api/users/:other`) — confirm the route handler that actually served the request via the response, not just the path string. | High |
| `final-state.md`, `screenshots/` | A feature flag this module found defaulting to `false` in the repo is actually `true` at runtime for this environment, and the gated UI renders. Refuted if the flag could be `true` only for this session's specific user/cohort (an A/B test, an internal-only override) — state whether the browser session used real or synthetic credentials before treating this as proof the flag is `true` for all users. | High |
| `network.jsonl` | An asset this module flagged as an orphan (zero `search_code` hits by filename) is actually requested by the browser during a confirmed flow — a request for that exact filename/path. Refuted if the request is a browser-generated implicit fetch (favicon, source map) unrelated to intentional application reference — check the request's initiator if the tool captures one before treating this as a live reference. | Medium |

## Severity guidance

| Situation | Severity |
|---|---|
| Client calls a state-changing endpoint that does not exist, traced to a state-changing path | Critical |
| Client calls a state-changing endpoint that does not exist, not traced | High |
| Client calls a read-only endpoint that does not exist | High |
| Code reads an env var nothing provides | High |
| Feature flag permanently off, gating shipped code | Medium |
| Exported symbol with zero callers, exclusions ruled out | Medium |
| Unused asset, dependency, or locale key | Low |
| Declared-and-unused type or interface | Info |
| Declared-and-unused config option | Low |
