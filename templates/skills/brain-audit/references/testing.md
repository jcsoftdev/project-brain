# Testing

Gate: test files are present **or conspicuously absent**. The absence case is the point — "this project has no tests" is a finding, not a reason to skip the module.

Coverage percentage is not the question, and that is not a stylistic preference — it is what the evidence shows. The largest study to date on real (not injected) defects — Kochhar, Lo, Lawall & Nagappan, "Code Coverage and Postrelease Defects: A Large-Scale Study on Open Source Projects," *IEEE Transactions on Reliability* 66(4), 2017, pp. 1213-1228 (DOI 10.1109/TR.2017.2727062), across 100 large open-source Java projects — found coverage has an **insignificant correlation** with post-release defect counts. Mutation testing correlates better with real fault detection, because it measures whether the suite would actually catch a change rather than whether a line merely executed, but computing a mutation score means running the suite against generated mutants — out of reach for this module. The question this module *can* answer by reading alone is: **which defects would this suite have caught?** Take the findings from the other modules and ask, for each, why no test failed.

There is no universal "correct" shape to check the suite against, either. The classic pyramid (many unit, fewer integration, few end-to-end) and Kent C. Dodds' "testing trophy" (weighted toward integration) are both defensible depending on where a project's defects actually originate — do not flag a project for favouring one over the other. What *is* a real finding is a mismatch between where tests concentrate and where risk concentrates: cross-reference `complexity.md`'s high-blast-radius symbols and `reachability.md`'s boundaries, then `search_code` those symbol names against the test suite. Heavy coverage on trivial code next to none on the central, high-blast-radius symbols is a gap regardless of which shape the suite otherwise resembles.

Everything below is established by reading test source and config — this module never runs the suite.

## Does the suite prove anything

- [ ] For each confirmed finding elsewhere in this audit, identify the missing test — `search_code` the file/function named in the finding against the test suite; no matching test file or describe block is the gap. That list is the most valuable output of this module.
- [ ] Tests assert behaviour, not implementation — `search_code` the suite for the test covering a finding above, and `Read` its assertions. A test that breaks on every refactor and passes through every real bug is negative value. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 13 — https://abseil.io/resources/swe-book/html/ch13.html; Fowler, "Mocks Aren't Stubs," martinfowler.com — https://martinfowler.com/articles/mocksArentStubs.html)
- [ ] Tests would fail if the feature broke — `find_symbol` the implementation the most important test covers, `Read` it, and mentally invert one condition. If no assertion in the test would catch the inversion, the test is not proving what it claims to.
- [ ] No test asserts only that a function was called — `search_code` for `toHaveBeenCalled()`/`toHaveBeenCalledWith()` with no accompanying assertion on a return value or side effect in the same test. Call-count assertions on a mock prove the test's own wiring, not the behaviour. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 13 — https://abseil.io/resources/swe-book/html/ch13.html)
- [ ] Assertions are specific — `search_code` for `toBeDefined()`, `toBeTruthy()`, `expect.anything()`, `assert.ok(` used where a specific expected value would fit. These pass on almost anything. (testsmells.org, tsDetect test-smell catalogue — https://www.testsmells.org/pages/testsmells.html)
- [ ] A test with many unlabelled assertions makes its own failure hard to diagnose — `search_code` test bodies for more than two or three bare assertion calls with no message argument and no single clear behaviour under test ("Assertion Roulette," a catalogued test smell). This is a maintainability finding, not a correctness one: the test still catches the bug, it just won't say which assertion caught it. (testsmells.org, tsDetect test-smell catalogue — https://www.testsmells.org/pages/testsmells.html)
- [ ] Coverage thresholds, where configured, function as a floor — `search_code` for a `coverageThreshold`/`coverage.thresholds` block (Jest/Vitest) and check whether every metric (statements/branches/functions/lines) is set to the same round number (e.g. all 80) with no per-file or per-directory override. A single uniform ceiling number, on a codebase large enough to have files of very different risk, is a target chased for its own sake rather than a gap-driven floor. Refuted if the project's high-blast-radius files (per `complexity.md`/`reachability.md`) independently show materially higher coverage than the threshold — the number is a backstop, not the target. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 11 — https://abseil.io/resources/swe-book/html/ch11.html)
- [ ] Assertions that compare a `.toString()`/JSON-stringified rendering of an object rather than its structured fields — `search_code` for `.toString()).toBe(`/`.toString()).toEqual(`/`JSON.stringify(...)).toBe(` patterns in test bodies. These break on any change to unrelated formatting (field order, whitespace, a new optional field) with no change to the behaviour under test. Refuted where the string/serialized form itself is the contract under test (e.g., testing a formatter or serializer's own output) — there the stringified value is the behaviour, not an implementation detail leaking through. (testsmells.org, tsDetect test-smell catalogue — https://www.testsmells.org/pages/testsmells.html; Fowler, "Mocks Aren't Stubs," martinfowler.com — https://martinfowler.com/articles/mocksArentStubs.html)

## Test doubles

- [ ] Mocks target code the project owns, not a third-party SDK or framework class reached directly — `search_code` the test suite for a mock/stub/spy applied to an imported third-party package. A mock of a dependency you don't own encodes an assumption about that dependency's contract that nothing revalidates; the contract can drift after a version bump while the mock — and the test — keeps passing. ("Don't mock what you don't own" — Freeman & Pryce, *Growing Object-Oriented Software, Guided by Tests*; reinforced in Google's own testing guidance — Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 13 — https://abseil.io/resources/swe-book/html/ch13.html.) Rule out a mock of a narrow, stable stdlib-equivalent surface where drift risk is negligible. A third-party class or interface mocked identically in many test files is a systemic contract-drift risk, not just a per-file smell — `search_code` for the same imported third-party symbol appearing inside a mock/stub/spy call across three or more distinct test files; each duplicate is a separate, unrevalidated assumption about that dependency's contract. Refuted if the mocked surface is centralized behind one shared test helper/factory that all three-plus files import, since a contract change then needs only one fix, not N.
- [ ] Where the codebase already wraps a third-party dependency in its own adapter, confirm tests mock the adapter and not the raw import — `search_code` for both the adapter's own test double and a direct mock of the underlying package inside the same test file. A test still reaching past the adapter defeats the reason the adapter exists.

## What is not covered

- [ ] Error paths — `search_code` each `throw`/rejected-promise site in the implementation, then `search_code` the test suite for a matching "throws"/"rejects" assertion. Most suites test only the happy path; cross-reference `failure.md`.
- [ ] Boundaries: empty, one, many, maximum, negative, zero, unicode, very long — `search_code` the test suite for these literal values (`''`, `0`, `-1`, `[]`) against the function under test. Their absence is the gap.
- [ ] Concurrency — `search_code` the test suite for `Promise.all`, parallel invocation, or a lock/mutex test. Tests run operations one at a time, which is why the defects in `concurrency.md` survive green suites. Note explicitly which are untestable as written.
- [ ] Idempotency and re-run paths — `search_code` for a test that invokes the same operation twice and asserts the second call's effect. Its absence next to an idempotency claim elsewhere in the code is the gap.
- [ ] Migration and upgrade paths — `search_code` test fixtures for one representing state written by a previous schema or version. Reading only current-shape fixtures means the suite never proves an upgrade path works.
- [ ] The packaged artefact, as a consumer would use it — `search_code` for a test that imports from the built output (`dist/`, the packed tarball) rather than source. The suite runs from the repository where every file exists, which is exactly why it misses packaging bugs. Cross-reference `packaging.md`.

## Test isolation

- [ ] **No test writes outside its own temporary directory.** `search_code` test files for `homedir()`, `os.homedir()`, a hardcoded absolute path, or a shared config/data directory. A write derived from any of these pollutes the developer's real environment and is `High` — and it is easy to introduce accidentally when production code resolves paths from `homedir()`. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 14 — https://abseil.io/resources/swe-book/html/ch14.html)
- [ ] Injection seams exist for anything that resolves a real path, spawns a process, or reaches the network — `search_code` test files for direct `fs.`, `child_process.`, or `http.`/`fetch(` calls that bypass a mock or an injected client. A direct call means the seam either doesn't exist or isn't used. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 13 — https://abseil.io/resources/swe-book/html/ch13.html)
- [ ] Tests do not depend on execution order or on each other's leftovers — `search_code` for module-level mutable state written in one test and read in another (a shared fixture reused without `beforeEach` resetting it). (testsmells.org, tsDetect test-smell catalogue — https://www.testsmells.org/pages/testsmells.html; Vitest core team, "Test Context," official docs — https://vitest.dev/guide/test-context.html)
- [ ] Each test cleans up on both the pass and the fail path — `search_code` for cleanup code placed inside the test body versus inside `afterEach`/`finally`. Cleanup only at the end of the body is skipped whenever an earlier assertion throws.
- [ ] Nothing hits a real paid or external endpoint — `search_code` for a live API base URL, an unmocked SDK client, or a real API key referenced inside a test file. Cross-reference `cost.md`. (testsmells.org, tsDetect test-smell catalogue — https://www.testsmells.org/pages/testsmells.html)
- [ ] Tests that resolve a base URL to anything other than localhost/a mocked server are nonhermetic — `search_code` the test suite (setup files, env fixtures, base-URL constants) for a hostname that is not `localhost`/`127.0.0.1`/a recognized in-process mock server, and cross-reference `.env.test`/CI config for the same variable. A suite that shares a staging environment with other test runs, or with production traffic, cannot guarantee the determinism this module's other isolation checks assume. Refuted if the shared host is a read-only, purpose-built test fixture environment gated by a separate credential the CI job scopes exclusively to test runs, with no production traffic ever landing there. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 14 — https://abseil.io/resources/swe-book/html/ch14.html)
- [ ] Test setup that reads a fixture file, directory, or external resource without first checking it exists — `search_code` test files for `fs.readFileSync`/`fs.readFile`/equivalent calls inside `beforeEach`/`beforeAll`/test bodies with no adjacent `fs.existsSync`/try-catch guard, where the file is not created by that same setup block. The test passes only when the ambient filesystem happens to be in the state the author assumed. Refuted if the same `beforeEach`/`beforeAll` block creates the file earlier in its own body — existence is then guaranteed by construction, not assumed. (testsmells.org, tsDetect test-smell catalogue — https://www.testsmells.org/pages/testsmells.html)

## Determinism

Flaky-test root causes have a stable, well-studied taxonomy (Luo et al., FSE 2014, independently reconfirmed since) clustering into non-determinism (races, shared mutable state, unseeded randomness), environment dependence (CI runner, timezone, locale), and order dependence (a test's pass depends on what ran before it). Of these, only non-determinism and order dependence leave a trace readable without executing the suite repeatedly — environment dependence is out of static reach entirely. The checks below, plus the isolation checks above, are what that reading finds.

- [ ] No dependence on wall-clock time, current date, timezone, or locale without control — `search_code` for `new Date()`/`Date.now()` inside code the tests exercise, and check whether the suite injects or freezes the clock (fake timers, an injected clock parameter) rather than reading the real one. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 14 — https://abseil.io/resources/swe-book/html/ch14.html)
- [ ] No dependence on unseeded randomness — `search_code` for `Math.random(` (or the language equivalent) in tested logic and confirm the test either seeds it or mocks the call.
- [ ] No fixed sleeps standing in for synchronisation — `search_code` test files for `sleep(`/`setTimeout(` used to wait for an async operation instead of awaiting it directly. That is a flake with a timer. (testsmells.org, tsDetect test-smell catalogue — https://www.testsmells.org/pages/testsmells.html; Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 14 — https://abseil.io/resources/swe-book/html/ch14.html)
- [ ] No dependence on a fixed port, or ports are allocated dynamically — `search_code` test setup for a literal port number (`.listen(3000)`). Fixed ports collide under parallel runs and in CI.
- [ ] **Known flaky tests are tracked, not tolerated.** `search_code` for `test.skip`, `.only`, a retry/`flaky` annotation, or a comment naming a test as unreliable. A test that fails one run in ten is a real signal being discarded — report each one with its observed failure rate if the repo records it (a CI badge, a flake-tracking issue). Cross-reference `runtime.md`, which reports a committed `.only`/`fit`/`fdescribe` in its own right, independent of whether the run currently passes. A global retry count greater than zero with no matching flaky-test record is the same signal inverted — `search_code` for `retries:` (Playwright/Vitest config) or a CI-level `--retries`/`--retry` flag set above 0 at the whole-suite level, then cross-reference this check; retries configured suite-wide, with no specific test named anywhere as the reason, mask exactly the signal this check exists to surface. Refuted if the retry count is scoped only to a CI job's known-nonhermetic large-test tier (e.g. only the e2e config, not unit config) and that scoping is itself documented in the same config file. (testsmells.org, tsDetect test-smell catalogue — https://www.testsmells.org/pages/testsmells.html; Playwright (Microsoft), "Retries," official docs — https://playwright.dev/docs/test-retries)

## Guard tests

- [ ] Where the codebase depends on two things agreeing — a manifest and a directory, a schema and a model, a gate table and a file set — a test asserts the agreement. `search_code` for both things being compared (the manifest read, the directory listing) inside the test suite. Hand-maintained lists are fine; unguarded hand-maintained lists are not.
- [ ] **A guard that cannot fail is not a guard.** Read the assertion itself rather than running it: an assertion comparing a value to itself (`expect(x).toEqual(x)`), one wrapped in a `try`/`catch` that swallows the failure, one behind a condition that is never true, or one that checks only that a function returned rather than what it returned — none of these can ever fail, regardless of what changes underneath them. Flag any guard test whose assertion has this shape. (testsmells.org, tsDetect test-smell catalogue — https://www.testsmells.org/pages/testsmells.html)

## Out of static reach

- Whether the suite actually passes right now — this module reads test source and config, it does not execute anything.
- Real flake rate — only observable from CI run history, which may live outside this repo's version control.
- Whether an order-dependency or shared-state pattern flagged above has ever actually produced a real race — confirming that requires executing under contention, not reading. Cross-reference `concurrency.md`.
- Environment-dependent flakiness (CI runner differences, resource limits, network latency) — invisible until the suite runs somewhere other than where it was written.
- Whether a mocked network or filesystem seam faithfully reproduces the real dependency's failure modes.
- Coverage percentage as measured by a coverage tool — this module infers gaps from what it reads, it does not instrument a run.
- Mutation score — the more strongly-correlated measure of test quality; this module can note the absence of a mutation-testing tool in the project config, but cannot compute or estimate the score itself.
- Whether a guard test that is structurally capable of failing has ever actually caught a real regression.
- Whether a coverage number is enforced as a floor or chased as a ceiling in practice — this module reads the threshold's configuration, not the team's history of decisions around it. Cross-reference `repo-history.md`.
- Whether new behaviour reliably arrives with a test, project-wide and over time (the "Beyoncé Rule") — this module reads the current suite, not the commit-by-commit discipline that produced it.
- Whether a test named/directory-classified as "small" (Google's small/medium/large taxonomy) is actually free of I/O and blocking calls at run time — `search_code` can find an `fs.`/`http.` call inside such a file, but confirming the call never actually executes (a dead branch, an always-mocked path) requires running it; only `runtime.md` can confirm.
- Whether a test needing retries fails because of a genuine race or because it is marginally slow under load — this module can find the retry configuration, not run the test enough times to tell the two apart. Cross-reference `runtime.md`.

Where `Runtime` is enabled, see `runtime.md`'s "What execution closes" for the pass/fail, flake-rate, and order-dependency items above, and its declared-coverage run (`runtime.md`'s run-steps section) for the coverage item, where a coverage script is declared.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `steps.md` cross-referenced with `search_code` of the e2e/integration test suite | A flow `browser.md` walked and confirmed working has no matching test in the suite — refuted if a test exists under a different name than the UI label; the auditor must actually open the candidate test file and confirm it exercises the same code path, not just that no name matches | High |

## Severity guidance

| Situation | Severity |
|---|---|
| No tests at all for correctness-critical logic | High |
| Test writes outside its temp directory into a real user path | High |
| Tests hitting real paid or external endpoints | High |
| A confirmed defect that the suite could have caught but does not | High |
| Guard test that cannot fail | Medium |
| Flaky test tolerated and untracked | Medium |
| No test for any error path | Medium |
| Fixed sleep standing in for synchronisation | Medium |
| Fixed port causing collisions under parallel runs | Medium |
| Mock of a third-party dependency the project doesn't own, wrapped nowhere | Medium |
| Same third-party type mocked identically across three or more test files, not centralized | Medium |
| Test suite resolves a base URL to a shared, non-local environment (nonhermetic) | Medium |
| Test setup reads a fixture/resource with no existence check (Resource Optimism) | Medium |
| Suite-wide retries configured with no matching flaky-test record | Medium |
| Tests asserting implementation rather than behaviour | Low |
| Assertion Roulette — many unlabelled assertions, unclear which failed | Low |
| Coverage threshold configured as a uniform ceiling, no per-file/per-directory floor | Low |
| Assertion compares a stringified/serialized rendering instead of structured fields (Sensitive Equality) | Low |
