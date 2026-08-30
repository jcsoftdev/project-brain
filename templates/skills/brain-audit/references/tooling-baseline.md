# Tooling Baseline

What does this project already check automatically, and does anyone actually look? Gate: a linter, formatter, type-checker, test-runner, or scanner configuration is present — or its absence is conspicuous enough to be the finding itself.

This audit otherwise reasons from source alone. Most projects already carry deterministic tooling that reasons about the same source more reliably — a rule a tool enforces cannot silently rot the way a convention this audit merely observes can. That configuration, and any output a tool has already produced, is evidence this audit would otherwise throw away, and it is stronger evidence than anything reasoned out fresh: SAST integrated with LLM review measurably beats either alone. This module owns the inventory-wide questions — what exists, what it actually enforces, what it has already produced — and does not duplicate work owned elsewhere: `type-safety.md` owns type-checker escape-hatch density specifically; `devops.md`'s Pipeline integrity section owns the mechanics of whether a CI step can fail the build; `consistency.md`'s Tooling agreement owns whether the *code* conforms to what one formatter/linter declares. This module owns the *inventory* across every tool category, the declared-vs-enforced gap as a structural question, and committed tool output as first-class evidence. A finding here that a project's own configured tool would already catch — but that is suppressed or never wired into CI — is `read`-tier under the Evidence Contract and unusually solid, because the "should this fail" question was answered by the tool's own author, not by this audit's judgement. The inverse also counts: a defect this audit reports elsewhere that the project's tooling *should* have caught, and did not, is itself a finding about the tooling, and belongs in this module, not buried in the module that found the defect.

## Inventory

- [ ] Locate every tool config in the tree — `search_code` for `.eslintrc`/`eslint.config`, `.prettierrc`, `biome.json`, `.stylelintrc`, `ruff.toml`/`pyproject.toml`'s `[tool.ruff]`, `.flake8`, `mypy.ini`/`pyrightconfig.json`, `tsconfig.json`, `go.mod`/`.golangci.yml`, `.rubocop.yml`, `checkstyle.xml`, a test-runner config (`jest.config`, `vitest.config`, `pytest.ini`), a SAST/dependency-scanner config (`.semgrep.yml`, `.snyk`, `codeql.yml`, `trivy.yaml`, `.bandit`), `.pre-commit-config.yaml`, `.editorconfig`. Record what each declares — existence alone is not the finding, its content is.
- [ ] Where tooling exists for one category but is conspicuously silent on an adjacent one the project clearly needs — a Python API handling auth with no `bandit`/`semgrep` config beside its `ruff` config — note the asymmetry; a gap in an otherwise-tooled project says more than a gap in an untooled one.
- [ ] Version-pin the tools themselves — `search_code` the manifest/lockfile for each tool's declared version. An unpinned linter/formatter version means the ruleset it enforces can shift between a CI run and a fresh clone without anyone touching the config.

## Declared versus enforced

The central check: a rule in a config nothing runs is a rule nobody obeys, and a scan that runs but does not gate the merge is theatre with a green checkmark.

- [ ] For every config found above, confirm a CI step actually invokes it — `search_code` the CI workflow files for the tool's run command (`eslint`, `ruff check`, `mypy`, `go vet`, `semgrep ci`). A config present with no matching CI invocation is enforced only on whichever machine happens to run it locally, if any does.
- [ ] Where CI does invoke it, confirm the step's failure fails the build. Cross-reference `devops.md`'s Pipeline integrity checks for the mechanics (`continue-on-error`, `|| true`, `--passWithNoTests`) — this module confirms the check exists and is wired in, `devops.md` owns whether it can actually fail; do not re-run that probe here.
- [ ] Where a pre-commit framework is configured, confirm the same hooks also run in CI, not only pre-commit — diff `.pre-commit-config.yaml`'s hook list against the CI workflow's step list. A hook that only pre-commit runs is bypassable with `--no-verify` or a clone that skipped `pre-commit install`.
- [ ] A scanner or checker that runs in CI but does not gate the merge — read the job's position in the workflow: a security-scan job with no branch-protection tie or `needs:` dependency feeding the merge check is informational only, and a red result there stops nothing.

## Suppression inventory

The gap between what a tool would flag and what it actually flags. This owns the general shape; `type-safety.md` owns type-checker suppression density specifically — do not re-derive that count here.

- [ ] Root-level rule disables across every config found in Inventory — `search_code` each config for a rules-off block (`"off"`/`0` in an eslint config, a bare `ignore =` in ruff/flake8, `disable=` in `.rubocop.yml`) — each is a policy decision covering the whole tree; list what it would otherwise have caught.
- [ ] Per-file and per-line suppressions, tallied separately from root-level ones — `search_code` for inline disable comments (`eslint-disable-next-line`, `# noqa`, `# pragma: no cover`, `// nolint`) and group by file. A cluster in one file is a different finding than the same count spread thin.
- [ ] Ignore files and exclude globs wide enough to remove a whole directory — read `.eslintignore`/`ignorePatterns`, `.prettierignore`, and each scanner's `exclude`/`paths-ignore`. A glob matching `**/legacy/**` or a `generated/` directory that is in fact hand-edited silently drops it from every check that config runs, not just one.
- [ ] Confirm the type checker itself is inventoried and wired in per the checks above, but stop there — `any`/`@ts-ignore`/`# type: ignore` density, reason-carrying, and scope are `type-safety.md`'s probes, not this module's.

## Committed tool output

- [ ] `search_code` for a committed SARIF file, coverage report (`coverage/`, `lcov.info`, `.coverage`), scanner baseline, or audit log checked into the repo. Where one exists, read it directly — it is `read`-tier evidence a deterministic tool produced, not evidence this audit reasoned out, and it is the strongest input available to the rest of the audit.
- [ ] Check its staleness before citing it — compare its embedded timestamp or generation commit against the current state of the files it describes. A report generated before the code it covers last changed is describing a version of the code that no longer exists.
- [ ] Where a coverage report is committed, read the numbers for the specific modules other findings in this audit touch, and cite them directly rather than estimating — this is measured, not inferred, even though `testing.md` owns the qualitative test-quality checks around it.
- [ ] A committed report showing zero findings from a scanner not wired into CI (per Declared versus enforced) is not evidence the code is clean — it is evidence of one run, possibly stale, that nothing repeats. State which is true before treating either as clean; a confident zero is exactly the "bug-free" framing that measurably suppresses detection elsewhere in this audit, and this module is where that framing enters.

## Baseline files

- [ ] Locate a baseline/ignore-existing-violations file for any scanner or linter (`.rubocop_todo.yml`, a generated ESLint baseline, a SonarQube/Semgrep baseline snapshot, mypy's `--baseline` output) — `search_code` for the tool's baseline-generation flag or a file matching its documented baseline naming.
- [ ] Confirm the baseline only ever shrinks — check whether CI compares against it for new entries, or whether the baseline-regeneration command runs as part of the normal lint step, which re-freezes every current violation as newly accepted on every run. A baseline that regenerates itself is not a baseline, it is a ratchet permanently stuck at zero, and that is a finding, not neutral infrastructure.
- [ ] A baseline with no visible owner, date, or shrink target is itself the finding — nobody is accountable for burning it down, and the tool it fronts has quietly become decoration for the code frozen inside it.

## Coverage of the tree

- [ ] For each config's `include`/`exclude`, confirm which top-level directories it actually reaches — read the scope against `list_modules` or the repo tree. Generated code, vendored dependencies, and test directories excluded on purpose are correct; the same exclusion silently covering a feature directory is not.
- [ ] Confirm test directories are excluded from *production-only rules*, not from the type checker outright — a config that drops `**/*.test.*` from type-checking entirely, rather than relaxing specific rules, lets test code drift from the types it exercises unnoticed. Cross-reference the test-time erosion check in `type-safety.md`.
- [ ] In a monorepo, confirm every package actually inherits the root config rather than shadowing it — `search_code` each package's own config for one that redefines rather than extends the root. A shadowed config is silent scope-narrowing nobody had to justify.

## What absence means

- [ ] Where Inventory found no linter, no type checker, and no test runner at all for a language capable of having them, state it plainly: every defect this audit reports in that code was invisible to automation before this audit ran, and will be again the moment it ends. That is a scoping instruction for the rest of the module selection, not a caveat — `consistency.md` and `reachability.md` carry more weight here because nothing else is checking.
- [ ] Where tooling covers one language or surface in a polyglot repo but not another — TypeScript linted, a Python service beside it left bare — name the asymmetry directly; it usually tracks which surface a team actually owns.

## Out of static reach

- Whether a suppression's stated reason is still true today, or a baseline entry's original cause has since been fixed elsewhere and only the freeze remains.
- Whether required CI checks are enforced by branch protection — a platform setting, not a file; cross-reference `devops.md`, which names this the same way.
- Real flake or noise rate of a configured scanner — only observable from run history this audit cannot read.
- Whether a tool absent from this repo runs upstream, in a monorepo sibling, or in an organisation-wide pipeline this audit cannot see.
- Whether a committed report's zero findings reflect a genuinely clean pass or a scanner misconfigured to match nothing.

## Severity guidance

| Situation | Severity |
|---|---|
| Configured tool would catch a real defect but is suppressed or never wired into CI | High |
| No linter, type checker, or test runner at all for a language that supports them | High |
| Baseline file that regenerates itself, freezing violations permanently at zero | High |
| Committed scanner output cited as clean but stale against current code | Medium |
| Scanner runs in CI but does not gate the merge | Medium |
| Root-level suppression disabling a rule tree-wide with no stated reason | Medium |
| Exclude glob silently covering a live feature directory | Medium |
| Baseline file with no owner, date, or shrink target | Medium |
| Tooling asymmetry across languages/surfaces in one repo | Low |
| Unpinned tool version in manifest/lockfile | Low |
| Isolated, justified per-line suppression | Info |
