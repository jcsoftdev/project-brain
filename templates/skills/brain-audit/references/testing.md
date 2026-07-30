# Testing

Gate: test files are present **or conspicuously absent**. The absence case is the point — "this project has no tests" is a finding, not a reason to skip the module.

Coverage percentage is not the question. The question is: **which defects would this suite have caught?** Take the findings from the other modules and ask, for each, why no test failed.

## Does the suite prove anything

- [ ] For each confirmed finding elsewhere in this audit, identify the missing test. That list is the most valuable output of this module.
- [ ] Tests assert behaviour, not implementation. A test that breaks on every refactor and passes through every real bug is negative value.
- [ ] Tests would fail if the feature broke. Try it mentally on the most important test: mutate the logic and ask whether an assertion catches it.
- [ ] No test asserts only that a function was called. Call-count assertions on a mock prove the test's own wiring.
- [ ] Assertions are specific — `toEqual` on a shape rather than `toBeDefined`, expected values rather than `expect.anything()`.

## What is not covered

- [ ] Error paths. Most suites test only the happy path; cross-reference `failure.md` and check each error branch has a test.
- [ ] Boundaries: empty, one, many, maximum, negative, zero, unicode, very long.
- [ ] Concurrency. Tests run operations one at a time, which is why the defects in `concurrency.md` survive green suites. Note explicitly which are untestable as written.
- [ ] Idempotency and re-run paths.
- [ ] Migration and upgrade paths — reading state written by the previous version.
- [ ] The packaged artefact, as a consumer would use it. Cross-reference `packaging.md`: the suite runs from the repository where every file exists, which is exactly why it misses packaging bugs.

## Test isolation

- [ ] **No test writes outside its own temporary directory.** Check for writes derived from the home directory, a global config path, or a shared data directory. A test that pollutes the developer's real environment is `High` — and it is easy to introduce accidentally when production code resolves paths from `homedir()`.
- [ ] Injection seams exist for anything that resolves a real path, spawns a process, or reaches the network — and the tests actually use them.
- [ ] Tests do not depend on execution order or on each other's leftovers.
- [ ] Each test cleans up on both the pass and the fail path.
- [ ] Nothing hits a real paid or external endpoint. Cross-reference `cost.md`.

## Determinism

- [ ] No dependence on wall-clock time, current date, timezone, or locale without control.
- [ ] No dependence on unseeded randomness.
- [ ] No fixed sleeps standing in for synchronisation — that is a flake with a timer.
- [ ] No dependence on a fixed port, or ports are allocated dynamically. Fixed ports collide under parallel runs and in CI.
- [ ] **Known flaky tests are tracked, not tolerated.** A test that fails one run in ten is a real signal being discarded. Report each one with its observed failure rate.

## Guard tests

- [ ] Where the codebase depends on two things agreeing — a manifest and a directory, a schema and a model, a gate table and a file set — a test asserts the agreement. Hand-maintained lists are fine; unguarded hand-maintained lists are not.
- [ ] **A guard nobody has watched fail is not a guard.** Verify each one by mutation: break the invariant deliberately, confirm the test fails, revert. Report guards that pass unconditionally.

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
| Tests asserting implementation rather than behaviour | Low |
