# Testing

Gate: test files are present **or conspicuously absent**. The absence case is the point — "this project has no tests" is a finding, not a reason to skip the module.

Coverage percentage is not the question, and that is not a stylistic preference — it is what the evidence shows. The largest study to date on real (not injected) defects — Zhang et al., "Code Coverage and Post-release Defects," *IEEE Transactions on Reliability*, 2017, 100 large open-source Java projects — found coverage has an **insignificant correlation** with post-release defect counts. Mutation testing correlates better with real fault detection, because it measures whether the suite would actually catch a change rather than whether a line merely executed, but computing a mutation score means running the suite against generated mutants — out of reach for this module. The question this module *can* answer by reading alone is: **which defects would this suite have caught?** Take the findings from the other modules and ask, for each, why no test failed.

There is no universal "correct" shape to check the suite against, either. The classic pyramid (many unit, fewer integration, few end-to-end) and Kent C. Dodds' "testing trophy" (weighted toward integration) are both defensible depending on where a project's defects actually originate — do not flag a project for favouring one over the other. What *is* a real finding is a mismatch between where tests concentrate and where risk concentrates: cross-reference `complexity.md`'s high-blast-radius symbols and `reachability.md`'s boundaries, then `search_code` those symbol names against the test suite. Heavy coverage on trivial code next to none on the central, high-blast-radius symbols is a gap regardless of which shape the suite otherwise resembles.

Everything below is established by reading test source and config — this module never runs the suite.

## Does the suite prove anything

- [ ] For each confirmed finding elsewhere in this audit, identify the missing test — `search_code` the file/function named in the finding against the test suite; no matching test file or describe block is the gap. That list is the most valuable output of this module.
- [ ] Tests assert behaviour, not implementation — read each test's assertions. A test that breaks on every refactor and passes through every real bug is negative value.
- [ ] Tests would fail if the feature broke — pick the most important test, read the implementation it covers, and mentally invert one condition. If no assertion in the test would catch the inversion, the test is not proving what it claims to.
- [ ] No test asserts only that a function was called — `search_code` for `toHaveBeenCalled()`/`toHaveBeenCalledWith()` with no accompanying assertion on a return value or side effect in the same test. Call-count assertions on a mock prove the test's own wiring, not the behaviour.
- [ ] Assertions are specific — `search_code` for `toBeDefined()`, `toBeTruthy()`, `expect.anything()`, `assert.ok(` used where a specific expected value would fit. These pass on almost anything.
- [ ] A test with many unlabelled assertions makes its own failure hard to diagnose — `search_code` test bodies for more than two or three bare assertion calls with no message argument and no single clear behaviour under test ("Assertion Roulette," a catalogued test smell). This is a maintainability finding, not a correctness one: the test still catches the bug, it just won't say which assertion caught it.

## Test doubles

- [ ] Mocks target code the project owns, not a third-party SDK or framework class reached directly — `search_code` the test suite for a mock/stub/spy applied to an imported third-party package. A mock of a dependency you don't own encodes an assumption about that dependency's contract that nothing revalidates; the contract can drift after a version bump while the mock — and the test — keeps passing. ("Don't mock what you don't own" — Freeman & Pryce, *Growing Object-Oriented Software, Guided by Tests*; reinforced in Google's own testing guidance.)
- [ ] Where the codebase already wraps a third-party dependency in its own adapter, confirm tests mock the adapter and not the raw import — `search_code` for both the adapter's own test double and a direct mock of the underlying package inside the same test file. A test still reaching past the adapter defeats the reason the adapter exists.

## What is not covered

- [ ] Error paths — `search_code` each `throw`/rejected-promise site in the implementation, then `search_code` the test suite for a matching "throws"/"rejects" assertion. Most suites test only the happy path; cross-reference `failure.md`.
- [ ] Boundaries: empty, one, many, maximum, negative, zero, unicode, very long — `search_code` the test suite for these literal values (`''`, `0`, `-1`, `[]`) against the function under test. Their absence is the gap.
- [ ] Concurrency — `search_code` the test suite for `Promise.all`, parallel invocation, or a lock/mutex test. Tests run operations one at a time, which is why the defects in `concurrency.md` survive green suites. Note explicitly which are untestable as written.
- [ ] Idempotency and re-run paths — `search_code` for a test that invokes the same operation twice and asserts the second call's effect. Its absence next to an idempotency claim elsewhere in the code is the gap.
- [ ] Migration and upgrade paths — `search_code` test fixtures for one representing state written by a previous schema or version. Reading only current-shape fixtures means the suite never proves an upgrade path works.
- [ ] The packaged artefact, as a consumer would use it — `search_code` for a test that imports from the built output (`dist/`, the packed tarball) rather than source. The suite runs from the repository where every file exists, which is exactly why it misses packaging bugs. Cross-reference `packaging.md`.

## Test isolation

- [ ] **No test writes outside its own temporary directory.** `search_code` test files for `homedir()`, `os.homedir()`, a hardcoded absolute path, or a shared config/data directory. A write derived from any of these pollutes the developer's real environment and is `High` — and it is easy to introduce accidentally when production code resolves paths from `homedir()`.
- [ ] Injection seams exist for anything that resolves a real path, spawns a process, or reaches the network — `search_code` test files for direct `fs.`, `child_process.`, or `http.`/`fetch(` calls that bypass a mock or an injected client. A direct call means the seam either doesn't exist or isn't used.
- [ ] Tests do not depend on execution order or on each other's leftovers — `search_code` for module-level mutable state written in one test and read in another (a shared fixture reused without `beforeEach` resetting it).
- [ ] Each test cleans up on both the pass and the fail path — `search_code` for cleanup code placed inside the test body versus inside `afterEach`/`finally`. Cleanup only at the end of the body is skipped whenever an earlier assertion throws.
- [ ] Nothing hits a real paid or external endpoint — `search_code` for a live API base URL, an unmocked SDK client, or a real API key referenced inside a test file. Cross-reference `cost.md`.

## Determinism

Flaky-test root causes have a stable, well-studied taxonomy (Luo et al., FSE 2014, independently reconfirmed since) clustering into non-determinism (races, shared mutable state, unseeded randomness), environment dependence (CI runner, timezone, locale), and order dependence (a test's pass depends on what ran before it). Of these, only non-determinism and order dependence leave a trace readable without executing the suite repeatedly — environment dependence is out of static reach entirely. The checks below, plus the isolation checks above, are what that reading finds.

- [ ] No dependence on wall-clock time, current date, timezone, or locale without control — `search_code` for `new Date()`/`Date.now()` inside code the tests exercise, and check whether the suite injects or freezes the clock (fake timers, an injected clock parameter) rather than reading the real one.
- [ ] No dependence on unseeded randomness — `search_code` for `Math.random(` (or the language equivalent) in tested logic and confirm the test either seeds it or mocks the call.
- [ ] No fixed sleeps standing in for synchronisation — `search_code` test files for `sleep(`/`setTimeout(` used to wait for an async operation instead of awaiting it directly. That is a flake with a timer.
- [ ] No dependence on a fixed port, or ports are allocated dynamically — `search_code` test setup for a literal port number (`.listen(3000)`). Fixed ports collide under parallel runs and in CI.
- [ ] **Known flaky tests are tracked, not tolerated.** `search_code` for `test.skip`, `.only`, a retry/`flaky` annotation, or a comment naming a test as unreliable. A test that fails one run in ten is a real signal being discarded — report each one with its observed failure rate if the repo records it (a CI badge, a flake-tracking issue).

## Guard tests

- [ ] Where the codebase depends on two things agreeing — a manifest and a directory, a schema and a model, a gate table and a file set — a test asserts the agreement. `search_code` for both things being compared (the manifest read, the directory listing) inside the test suite. Hand-maintained lists are fine; unguarded hand-maintained lists are not.
- [ ] **A guard that cannot fail is not a guard.** Read the assertion itself rather than running it: an assertion comparing a value to itself (`expect(x).toEqual(x)`), one wrapped in a `try`/`catch` that swallows the failure, one behind a condition that is never true, or one that checks only that a function returned rather than what it returned — none of these can ever fail, regardless of what changes underneath them. Flag any guard test whose assertion has this shape.

## Out of static reach

- Whether the suite actually passes right now — this module reads test source and config, it does not execute anything.
- Real flake rate — only observable from CI run history, which may live outside this repo's version control.
- Whether an order-dependency or shared-state pattern flagged above has ever actually produced a real race — confirming that requires executing under contention, not reading. Cross-reference `concurrency.md`.
- Environment-dependent flakiness (CI runner differences, resource limits, network latency) — invisible until the suite runs somewhere other than where it was written.
- Whether a mocked network or filesystem seam faithfully reproduces the real dependency's failure modes.
- Coverage percentage as measured by a coverage tool — this module infers gaps from what it reads, it does not instrument a run.
- Mutation score — the more strongly-correlated measure of test quality; this module can note the absence of a mutation-testing tool in the project config, but cannot compute or estimate the score itself.
- Whether a guard test that is structurally capable of failing has ever actually caught a real regression.

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
| Tests asserting implementation rather than behaviour | Low |
| Assertion Roulette — many unlabelled assertions, unclear which failed | Low |
