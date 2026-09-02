# Runtime

Does the project's own tooling actually pass right now? Gate: the user explicitly enables execution, **and** the project declares at least one runnable command. The `executed` tier has sat in the Evidence Contract since this skill defined its tiers, reserved with no module to fill it — this is that module. It runs now, and only when both conditions hold together; either alone leaves it gated off.

Every other module in this skill reasons from source alone — a defect it reports is a claim about what the code would do, never a claim about what it did. This module is the one exception, and the exception is narrow: with the user's consent, it runs the commands the project's own authors already run — the script named `test` in `package.json`, a documented `typecheck`/`lint`/`build` target, a command already invoked by a CI workflow — and reads what actually happened. It does not repeat `tooling-baseline.md`'s inventory of what a project declares versus what CI enforces; it consumes that inventory to decide what is safe to run, then reports the result of running it. It does not repeat `testing.md`'s reading of test source either — that module tells you what a suite claims to prove and what shape its assertions take; this module tells you whether the suite the project already trusts currently passes.

The constraint carries no exceptions: **this module runs only commands the project itself already declares.** It never invents a command, installs a dependency, reaches the network beyond what a declared command already does on its own, touches a production system, or runs a script whose name implies mutation (`deploy`, `publish`, `migrate`, `seed`, `reset`, `clean`) without the user naming that exact script. A command not already declared somewhere does not get run speculatively — its absence is the finding, under Establish what the project declares, not a gap this module fills by guessing.

**Every finding from this module records the exact command, its exit code, and the relevant output line — that triple is what makes it `executed` rather than a better-dressed `inferred`.** "The tests fail" with no command, no exit code, and no failing assertion quoted has not earned the tier it claims; report it as `inferred` instead, because an unverifiable `executed` finding is worse than an honest one — the tier alone would let it reach Critical.

**A green run is evidence that the project's own checks pass, and it is exactly as strong as those checks are — nothing more.** Cross-reference `tooling-baseline.md`, which measures that strength directly: a green test run against a suite that only asserts `toBeTruthy()`, or a green lint run against a ruleset with its real rules disabled, is a true statement about a weak instrument. State which is true before citing a pass as reassurance.

## Establish what the project declares

- [ ] Locate the declared command surface before running anything — read `package.json` scripts, a `Makefile`, a documented `just`/`task` runner, or the CI workflow's own step list, cross-referencing `tooling-baseline.md`'s inventory rather than re-deriving it. Record the exact command string for each of test, typecheck, lint, and build; this module runs nothing it cannot cite from one of these sources.
- [ ] A category with no declared command ends the module for that category — state plainly which of test/typecheck/lint/build had nothing to run, and never substitute a guessed invocation. `npm test` on a project with no `test` script is npm's own fallback failure, not a declared command.
- [ ] Read the command's body or documented prerequisites before running it — an undeclared required env var or an expected service on a fixed port fails the run for reasons unrelated to the code under audit, and reporting that failure as a code defect misattributes it.
- [ ] Where a category has two candidate commands — a root script and a per-package one in a monorepo, or a local one that diverges from CI's — run the one `tooling-baseline.md`'s Declared-versus-enforced findings show CI actually invokes, not merely the one that exists.

## Execution safety

- [ ] Every command runs under a timeout, and the value used is recorded in the finding. No industry default exists to defer to — of the harnesses with a public execution model, only Claude Code documents a numeric figure (120s soft, 600s hard); state the bound this run used rather than assuming a reader knows it.
- [ ] Network access during the run is scoped to what the declared command itself needs. A test suite reaching out during a run neither described nor requested by its own configuration is a finding in its own right — cross-reference `security.md` — not something silently permitted because the run was allowed to start.
- [ ] Nothing in the run writes outside the checked-out working tree — cross-reference `testing.md`'s isolation checks (`homedir()`, a hardcoded absolute path). A suite that fails this check is not executed to completion; its failure mode is reported and the run stops there.
- [ ] A script whose name implies mutation (`deploy`, `publish`, `migrate`, `seed`, `reset`, `clean`) is recorded under Establish what the project declares but never executed on the strength of appearing there — only on the user naming that exact script by name.
- [ ] State begins clean before every run: a frozen install (`npm ci`, `pnpm install --frozen-lockfile`, or the project's equivalent) against the committed lockfile, not a reused `node_modules`. Note whether a build cache was warm or cold — a result measured against drifted dependencies or a stale cache is evidence about that drift, not about the code.

## Long-running commands

Everything above assumes a command that terminates. A `dev`/`start`/`preview`/`serve` script does not, and starting one is a different contract — this section is that contract, and `browser.md` relies on it rather than restating it. A server is started only when the user enabled execution **and** named the purpose that needs it (browser observation, or a declared smoke test against a live port); it is never started to "see what happens".

- [ ] The port comes from the script itself or its documented config (`PORT=` in the script body, a `--port` flag, `.env.example`, the framework's config file) — record where it was read from. If that port is already bound, stop and report which process holds it (`lsof -i :<port>` or the platform equivalent, quoted). Never pick another port, never kill the occupant.
- [ ] An already-running server is reused only when the user names its URL. A server answering on a framework's default port is not assumed to be this project's — a stale process from another checkout looks identical from the outside, and every observation against it would be about the wrong code.
- [ ] Readiness is an HTTP probe against the target URL, repeated until a 2xx/3xx or a stated timeout (default 60 s; record the value used). A server that never answers is this module's finding — record the command, the elapsed time, and the last stderr line — and browser observation reports `not applicable (target never became ready)` rather than walking a dead URL.
- [ ] The server's stdout/stderr is captured for the whole session and cited by line where a browser-side finding has a server-side counterpart (a 500 in `network.jsonl` with its stack trace in the server log is one finding, `observed` on the browser side and `executed` on this side, not two).
- [ ] Teardown is unconditional: the process this module started is stopped when the last flow finishes or fails, including on error, and the report records that it was stopped. A server the audit did not start is never stopped.

## The cheap ladder

- [ ] Typecheck first. Record exit code and, on failure, the error count. A failing typecheck makes every later step's findings suspect — code that does not typecheck may not build or behave the way the suite assumes — so treat this failure as gating, not as one finding among several.
- [ ] Lint second, after typecheck. Record exit code and violation count. A lint failure does not gate the remaining steps the way a typecheck failure does, but a ruleset the project itself enforces and currently fails is `tooling-baseline.md`'s declared-versus-enforced gap made concrete, and belongs cited there too.
- [ ] Build third. Record exit code and, on failure, the first fatal error. A failing build means every other finding this audit makes about wiring or flow completion (`flow-integrity.md`) describes code that cannot currently ship — say so explicitly rather than letting those findings stand unqualified.
- [ ] State the ladder's stopping point plainly. If typecheck fails, say whether lint and build were still attempted or skipped, and why — a module that silently stops after step one looks identical to one that never attempted steps two and three.

## The suite

- [ ] Run the declared test command once. Record exit code, wall-clock duration, and the pass/fail/skip counts from the runner's own summary line — this is the module's core `executed` finding, and every other check in this section refines it.
- [ ] Name skipped and pending tests, not just their count — `search_code` the source for `.skip`/`xit`/`xdescribe`, then confirm the run's own output reports the same number. A mismatch means the skip markers moved since whatever baseline the project last recorded.
- [ ] A committed `.only`/`fit`/`fdescribe` is a finding independent of whether the run currently passes — it silences the rest of the suite for every contributor who runs it locally, and a CI run would show a misleadingly small pass count if it slipped past review.
- [ ] Repeat the run **ten times** against an unchanged tree. Ten is not arbitrary — it is the threshold Google's own flaky-test infrastructure uses to reclassify a passing-after-failure test as flaky (Luo et al., FSE 2014). Report the observed rate (`n/10`) rather than a bare "flaky" label.
- [ ] Where the runner supports randomised or reversed ordering, run it once out of committed order and diff the result against the unshuffled run. iDFlakies (ICST 2019) found roughly half of real flaky tests are order-dependent — invisible to a suite that only ever runs in the order it is committed in.
- [ ] Where a coverage script is separately declared, run it and read the number for exactly what it proves: which lines executed at least once. Kochhar, Lo, Lawall & Nagappan (*IEEE Transactions on Reliability* 66(4), 2017) found coverage has an insignificant correlation with post-release defects — the number is real and measured, but it is evidence of exercised lines, never of correctness, and must never be reported as the latter.
- [ ] Cross-reference the coverage run's per-file breakdown against symbols `complexity.md`/`reachability.md` already flagged as high-blast-radius — a 0% line on one of those is a sharper, measured version of an existing finding, not a new one.

## What execution closes

- [ ] `testing.md` lists "whether the suite actually passes right now" as beyond its static reach — the run above closes it directly. Cite the exit code, not a restatement.
- [ ] `testing.md` also lists real flake rate and whether a flagged order-dependency pattern has ever actually failed as unreachable statically — the repeat and shuffled-order runs close both, bounded by what ten repeats and one reorder can show. A clean result there is flake-free at that sampled rate, not flake-free forever.
- [ ] `tooling-baseline.md` lists "whether a committed report's zero findings reflect a genuinely clean pass or a scanner matching nothing" as unreachable statically — rerunning the same scanner now and diffing against the committed report closes it: an identical zero is corroboration, a fresh non-zero means the committed report was stale or the scanner regressed.
- [ ] Where a browser-driving command is separately declared — an axe-core CI script, a Lighthouse CI run — treat it as its own declared command under Establish what the project declares and run it the same way; its result is bounded, see What execution still does not settle, but it is real measurement where none existed before.

## What execution still does not settle

- [ ] A green run proves the project's own checks pass and nothing beyond what those checks were written to catch. Restate this in the finding itself, not only here — a green `executed` result inherits every blind spot `tooling-baseline.md` already found in what the tooling actually enforces.
- [ ] Mutation score, behaviour under real production traffic, environment-dependent flakiness (a different CI runner, timezone, locale), and whether a mocked seam faithfully reproduces its real dependency all stay out of reach — none are observable from a local run, however many times repeated.
- [ ] An axe-core run, where declared, is bounded at roughly 57% of real-world accessibility issues per Deque's own study of over 2,000 audits — a different and larger figure than the share of WCAG success criteria automatable, which is smaller and commonly conflated with it. The rest still needs `accessibility.md`'s manual checks.
- [ ] A Lighthouse or Core Web Vitals lab run, where declared, is `executed`-tier for the single run it performed and nothing beyond — usable as a regression check against a prior run, never as proof of a real-world pass. It cannot measure INP at all (INP requires a genuine user interaction) and only partially observes CLS, so it never substitutes for the field data `performance.md` already lists as out of reach — `browser.md`'s driven session closes the INP gap directly via a real interaction in `vitals.md`.
- [ ] Rendering correctness, the keyboard walk, and real screen-reader output stay out of reach for **this module** unless the project separately declares a browser-driving command — that limitation is specific to running the project's own declared tooling; `browser.md` reaches all three unconditionally via its own separate consent.

## Out of static reach

- Whether a result holds on infrastructure other than the one this ran on — a different OS, CPU architecture, or language/runtime version can behave differently against an identical lockfile.
- Real-world flake rate beyond the sampled repeat count — ten repeats bounds a claim, it does not eliminate a rarer failure mode.
- Whether a currently-green suite would still be green against a change the project has not made yet; this module reports the present state of the tree, not a prediction.
- Whether the commands this module ran are the ones a human contributor actually runs day to day, versus a stale or aspirational script nobody invokes.
- Anything requiring a live third-party network dependency, a paid API, or a production credential this module is barred from reaching.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl` | Request/response shape (method, URL, status, size, duration) of a live third-party network dependency actually called during a confirmed flow | Info |

## Severity guidance

| Situation | Severity |
|---|---|
| Declared build fails | Critical |
| Declared test suite fails on the current tree | Critical |
| Committed `.only`/`fit`/`fdescribe` silencing the rest of the suite | High |
| Declared typecheck fails | High |
| Declared `dev`/`start`/`preview` server never answered the readiness probe within the recorded timeout | High |
| Server the audit started could not be confirmed stopped at teardown | High |
| Port the declared script binds is already held by a process outside the audit (server not started, occupant named) | Medium |
| Test flaky at 2 or more failures in ten repeats, untracked | High |
| Order-dependent failure surfaced by a reordered run | High |
| Declared lint fails against the project's own configured ruleset | Medium |
| Skipped tests present with no tracking issue or comment | Medium |
| Coverage run confirms 0% on a symbol another module flagged high-blast-radius | Medium |
| Committed scanner report contradicted by a fresh run of the same scanner | Medium |
| Test flaky at exactly one failure in ten repeats | Low |
| Result measured against a stale cache or drifted dependency install | Info |
