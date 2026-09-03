---
name: brain-audit
description: "Trigger: audit this project, comprehensive audit, full codebase audit, find dead code, unused features, orphan buttons, broken flows, security/performance/architecture audit. Discovers architecture via project-brain, proposes an audit module set, runs only what the user confirms, and reports findings by severity."
license: Apache-2.0
metadata:
  author: jcsoftdev
  version: "2.4"
  generator: project-brain
---

<!--
  `generator: project-brain` is an ownership marker, not decoration.
  `project-brain setup` overwrites this directory only when it finds that line;
  without it, setup treats the directory as hand-written and leaves it alone.
  Strip it and you pin this copy forever — no upgrade will ever reach it.
-->


## Activation Contract

Apply when asked for a whole-project audit — not a single diff or PR review. Works on any project type: never assume frontend/backend/mobile/CLI before discovery confirms it.

Do not apply when: the ask is scoped to one diff, PR, or file; or the project is not project-brain-indexed — fall back to manual discovery and say so explicitly in the output.

**Indexed means `check_health` succeeded AND reported `chunks` above zero.** An unindexed project does not fail the call: it returns `{"store":"connected","embeddings":"available","chunks":0}` — a healthy server with nothing in it. Treating only a thrown error as "not indexed" lets every later `search_context` come back empty, and the audit then reports "no findings" for a project it never actually read. Check the count, not just the call.

## Hard Rules

- Discovery first, audit second. No module runs before discovery completes.
- **No module runs before the user confirms the module set.** Present the proposal, wait, then load references. Never load all modules by default.
- Route discovery through project-brain, not raw Read/grep sweeps:

| Need | Tool |
|------|------|
| Stack / module overview | `get_architecture` |
| Where to start reading | `repo_map` |
| "How does X work" (no exact name) | `search_context` → `expand_context(chunk_id)` |
| Exact symbol / file / config | `find_symbol` or `search_code` |
| Is this symbol dead? | `find_callers` (empty ⇒ no in-repo caller) |
| What does this depend on? | `find_callees` |
| Blast radius | `impact` |
| Does A reach B? | `trace_path` |
| Results look empty or stale | `check_health` (read `chunks`, not just success), then `sync_project` |

- `find_callers` returning empty means no **in-repo** caller. Before reporting dead code, rule out: public API surface, dynamic dispatch, reflection, string-keyed registries, framework-convention entry points. State which you ruled out.
- Every finding requires: Title, Category, Severity, **Evidence Tier**, Confidence (0-100%), Evidence (`file:line`), Business impact, Technical impact, Recommendation, Priority, **Refutation**. Never invent a finding.
- **No finding at Medium or above reaches the report without a refutation verdict.** Not refuted, not declined, not below threshold — one of those four, stated. A finding whose `Refutation` field is empty has not finished the pipeline.
- Severity vocabulary is exactly: Critical | High | Medium | Low | Info.

## Evidence Contract

The single most likely failure of this audit is not missing a defect — it is reporting one that is not there. A confident finding with nothing behind it is indistinguishable, to the reader, from a real one, and it costs them the afternoon that proves it false. Every finding therefore declares **how it was established**, and that declaration caps how severe it is allowed to be.

| Tier | Established by | Severity ceiling |
|---|---|---|
| `executed` | A command was run and its output read. Only `runtime.md` reaches this tier, only when the user enabled execution, and only with the command and its exit code recorded. | Critical |
| `observed` | Established by a browser tool against a named URL. Only `browser.md` and the modules consuming its bundle reach this tier, only when the user enabled browser observation, and only with the URL, the tool that filled each role, and the artefact path with a line or timestamp recorded. A single run is lab data, never evidence about real users. | Critical |
| `traced` | A structural proof from project-brain: `trace_path`, `find_callers`, `find_callees`, or `impact` showing the path exists, or provably does not. | Critical |
| `read` | A cited `file:line` whose content was actually read, quoted or paraphrased faithfully. | High |
| `inferred` | A pattern, a naming smell, or an absence with no probe run against it. | Medium |

- **An `inferred` finding can never exceed `Medium`**, no matter how severe it would be if true. Its severity is a function of what you proved, not of what you fear. If it deserves `Critical`, go and prove it — then it is `traced` and it earns the severity.
- A finding with no tier is not a finding. Drop it or promote it.
- **A `Severity guidance` row above the ceiling of the check that feeds it must name the probe that reaches that ceiling.** A row awarding `Critical` to a situation whose only probe is `search_code` plus reading the hit is a contradiction: the check can reach `read`, and `read` stops at `High`. Either the check names the structural probe (`find_callers`, `trace_path`, `impact`) that proves the reach, or the row caps at `High`.
- Confidence is separate from tier: tier says *what kind* of evidence, confidence says *how strong*. A `read` finding with one ambiguous line is `read` at 40%.

**Falsification is part of the finding.** For every check that can produce a false positive, state what would refute it and confirm you ruled that out. `reachability.md` and `concurrency.md` already do this; the pattern is the standard, not their local quirk.

**"No findings" is a complete and valid result — when it is earned.** A module that ran its probes and found nothing reports clean, and that is the deliverable. Nothing here rewards volume, and a padded module is worse than an absent one: it buries the real findings among the invented ones. Never manufacture a finding to justify having run a module.

The counterweight, because this rule cuts both ways: **a clean result is only valid if the probes actually ran.** Not looking produces the same output as looking and finding nothing, and the two are indistinguishable in the report. So a module reporting clean states which probes it ran and what they returned. "No hardcoded colours — `search_code` for `#[0-9a-f]{3,8}` returned 4 hits, all inside the token file" is a clean result. "No issues found" is not a result at all.

This matters more than it looks. Measured precision for frontier models on security review runs 29-42%, so most raw findings are false — but the same research finds that **models miss far more than they invent**, and that a report with fewer findings reads as more accurate precisely when it is least accurate. That is the precision paradox: the audit that missed everything and the audit that found nothing look identical on the page. Suppressing a real finding is the failure this skill is worst at noticing in itself.

## Execution

**This audit reads. It does not run anything and does not open a browser unless the user says so, in this session, for this run.**

Every other module in this skill is static, and that is a promise the user relies on: pointing an audit at a repository must not be a way to execute its code or to drive a browser against it. The `Runtime` and `Browser` modules are the two exceptions, each behind its own consent. `Runtime` is off unless three conditions all hold.

1. **The user enabled it explicitly.** Not a default, not inferred from a project type, not carried over from a previous run, and not implied by confirming the module set. `Runtime` is offered separately from every other module, after the rest are chosen, and the offer states plainly what running it means: the project's code will execute on this machine.
2. **The project declares the command.** `Runtime` runs what the repository already tells its own contributors to run — a script in the manifest, a step in a CI workflow, a documented command. **It never invents one.** This is the constraint that makes execution defensible: the audit runs what the authors already run, and the audit's own judgement is not what decides that a command is safe.
3. **The command is not destructive.** A declared script whose name or body deploys, publishes, migrates, seeds, resets, or deletes is never run on inference. If a finding genuinely needs one, name it, say why, and let the user run it themselves.

`Browser` is offered after `Runtime`, separately again, and is off unless three conditions of its own hold: a UI or HTML-serving entry point was detected, the user enabled browser observation explicitly for this run, and a target URL exists — supplied by the user, or a declared `dev`/`start`/`preview` script the user has also allowed `Runtime` to start. The offer names the tool filling each role, states whether any role runs inside the user's real signed-in browser (never by default — see `browser.md`), lists the flows it will walk, and prints the total number of passes, so the user consents to a count, not to "a run". Flows are read-only unless the user names a side-effecting one, exactly as `Runtime` treats `deploy`/`migrate`/`seed`.

Refusing execution or observation is always a valid answer and costs the audit only the `executed` or `observed` tier. Every module already declares what it cannot see from source in its `Out of static reach` section; with execution off, those items are reported as Coverage Gaps exactly as they were before. **The static audit is complete without these modules** — `Runtime` and `Browser` close gaps, they do not fill holes.

A finding at `executed` tier records the exact command, its exit code, and the output line that supports it. Without those three it is not `executed`; it is an `inferred` finding wearing a tier that lets it reach Critical, which is worse than an honest `inferred`. And a green run proves only that the project's own checks pass, which is as strong as those checks are — `tooling-baseline.md` is what measures that, and the two modules are read together or neither is worth much.

## Refutation

The Evidence Contract governs how a finding is established. This section governs whether it survives.

Falsification inside a check is self-falsification: performed by the agent that wants the finding to be true, in the context that produced it, moments after producing it. It is worth doing and it is not adversarial. Measured precision for frontier models on security review is 29-42%, so most raw findings are false, and a pipeline whose findings graduate by default inherits that number wholesale. Refute-or-Promote (arXiv 2604.19049) killed roughly 79% of 171 candidates before disclosure, 83% prospectively on a 30-candidate subset, by giving a separate agent one instruction: destroy this. That is the stage.

**This is not a quota.** Those numbers are an outcome on someone else's corpus, not a target for yours. A refuter that kills four in five because it was told four in five should die has replaced one bias with a worse one — and the worse one is invisible, because a wrongly killed finding leaves nothing on the page to argue with. Killing real findings compounds the failure this audit is already worst at: the same research finds false-negative bias exceeds false-positive bias in every model tested. Refutation trades recall for precision on purpose. The user is entitled to know which way the trade points, so the report says so.

### What gets refuted

Every finding at **Medium or above**, one refuter each. Low and Info are exempt on cost of error — a false Low costs a shrug, a false High costs an afternoon — and carry `not attempted (below threshold)` rather than passing silently. The threshold sits at Medium and not at High because `inferred` caps at Medium, so every speculative finding in the report lands exactly on the line, and speculative findings are the cheapest to kill and the likeliest to be false.

One refuter per finding. A second is launched only when the first returns `undetermined` on a Critical or High finding, and it is told which probes were already inconclusive so it does not repeat them. Never a third. Two refuters on identical briefs are not independent, and a panel is a design that only pays at a hundred findings.

### The mandate

The refuter is told to destroy the finding, and told that destruction is expensive. It may kill on exactly one of five grounds, and must name it:

| Ground | Requires |
|---|---|
| `MISQUOTE` | The cited location does not contain what the finding says it does. |
| `GUARD` | A check, constraint, schema, or type at a cited `file:line` makes the described failure impossible. |
| `UNREACHABLE` | A structural probe shows the path the finding depends on does not exist. Quote the probe result. |
| `IMPOSSIBLE` | The mechanism cannot occur in this language or runtime. Concretely; "unlikely" is not this ground. |
| `INTENDED` | The behaviour is deliberately enforced. Cite the enforcing code, not a comment describing it. |

A kill requires evidence at the tier the finding claims, or higher. **Failing to find support for a finding is not refuting it** — that is `unrefuted`, and it is a correct and complete answer. Every verdict, kills and survivals alike, lists the probes that were run; a verdict with no probe list is void and the finding survives. This is the clean-module rule from the Evidence Contract applied one level up: not looking and looking-and-finding-nothing produce the same verdict, and only the probe list separates them.

The refuter cannot execute anything and does not open a browser, for the same reason. If a claim can only be settled by running the code or by re-observing it, the verdict is `undetermined`. An `observed` finding is killed by `MISQUOTE` against the cited artefact line or by `INTENDED`; nothing else reaches it.

### Context asymmetry

The refuter is a subagent with a fresh context. It receives the title, the module and the single check bullet that produced the finding, the claimed severity and tier, the cited `file:line` list, the finder's quoted excerpt, and the finder's stated rule-out. Nothing else.

It does not receive the finder's confidence figure, its reasoning, its tool transcript, any other finding, the full module reference, the discovery summary, or **any of the project's self-description**. That last exclusion is the same instrument as `## Reading the project's own words`, and it matters more here: a refuter under a kill mandate reads a confident README as a ready-made `GUARD`. Metadata redaction recovered 68.75% of suppressed detections in study; the explicit instruction recovered 94%; the refuter gets both, because together they are four lines of prompt.

The excerpt is handed over **as a quotation to be checked against the file, never as a fact**. Withhold it and `MISQUOTE` becomes undetectable — there is nothing to compare the file against. Hand it over as evidence and the refuter reasons from the quote instead of the code. Hand it over as a claim about the file and both failures close.

### Mode, and honest degradation

| Mode | Condition |
|---|---|
| `cross-model` | A subagent ran on a model you can **name**, different from the one you can **name** for yourself. |
| `cross-context` | A subagent ran on a fresh context; one or both model ids unknown, or only one model available. |
| `self-review` | No subagent mechanism. Not adversarial. |

**Never label a run `cross-model` unless both model ids appear in the report.** Requesting a different model is not evidence a different model answered; unconfirmed, it is `cross-context (model unknown)`.

`self-review` verdicts are reported as `self-reviewed`, never as `survived`, and the Executive Summary states that no adversarial stage ran. In this mode a refuter's probe can never promote a tier — a probe run in the finder's own context is not a new instrument, it is the finder running one more probe, which step 4 already required.

### Verdicts

| Verdict | Effect |
|---|---|
| `refuted` | Removed from Findings. One line in the Refutation Ledger. |
| `weakened` | Survives at the reduced severity the refuter names; tier drops if the surviving part rests on weaker evidence. |
| `unrefuted` | Survives unchanged. |
| `undetermined` | Survives, **capped at Medium**, flagged as unsettled by static analysis. |

`weakened` carries most of the value. The common outcome is not "this is fake" but "this is a Medium wearing a Critical's clothes" — the injection is real, the input is an internal enum. Without its own verdict that outcome is either a lost true finding or a retained inflated severity.

### How this extends the Evidence Contract

Two additions, both additive; the tiers and their ceilings are otherwise untouched.

- A required `Refutation` field on every finding: `<verdict> · <mode> · <one-line note>`.
- One new ceiling: **`undetermined` caps at Medium** — the same ceiling `inferred` carries, for the same reason. An unverified claim is unverified regardless of which stage failed to verify it. The tier records what established the finding; the cap records what is still unknown; they stay separate.

**Surviving refutation does not promote a tier.** Tier states what kind of evidence established a finding, and survival is the absence of a counter-proof. Promoting `read` to `traced` because nobody could kill it launders an absence into a proof — the same category error as letting confidence bleed into tier. The one legitimate exception is not an exception to this rule but an application of the contract: **a refuter's probe result is evidence like any other and is tiered on its own merits.** If the refuter, trying to kill, runs a `trace_path` the finder never ran and it confirms the path, the finding is now `traced` and cites that probe. The promotion comes from the probe, never from the survival.

### The ledger

Killed findings are reported, one line each, in a **Refutation Ledger** after Coverage Gaps: title, location, claimed severity, ground, and the refutation in a sentence. Never in Findings by Severity, and the section header says so.

They are reported rather than dropped because a killed finding is a claim that will be made again — by the next audit, by a reviewer, by a scanner — and the ground of the kill is durable knowledge the audit already paid for. Because a ledger of thin refutations is how the user catches a refuter that is over-killing, and silent dropping makes the kill stage unfalsifiable. And because of the precision paradox one more time: a three-finding report with no ledger is indistinguishable from an audit that never ran, while three findings over a fourteen-line ledger shows the shape of the work.

## Reading the project's own words

Several modules deliberately read what the project says about itself — the stated goal in `goal.md`, the README claims in `functional.md`, the docs in `documentation.md`, commit messages in `repo-history.md`. That input is necessary: you cannot audit "claimed versus real behaviour" without the claim.

It is also the single largest measured threat to this audit's accuracy. In controlled study, framing code as potentially vulnerable raised false positives by only 0.8-13.6 percentage points, while framing the same code as bug-free **dropped detection by 16 to 93 percentage points**. A confident README, a commit message asserting a fix, a doc section describing a safeguard — each is that framing, and each arrives before the code does.

So, without exception:

- **Project self-description is a claim under test, never evidence that the claim holds.** "The docs say inputs are validated" is a hypothesis to check, and finding no validation is the finding — not a contradiction to explain away.
- **Never let a stated intention lower suspicion.** A comment saying `// sanitised upstream`, a variable named `safeInput`, a test file named `security.test.ts` — none of these are evidence. Trace the value.
- **When a module has read the project's claims, say so in that module's findings.** A reader deserves to know which conclusions were formed after exposure to the project's own framing.
- Where a check can be run against the code alone, **run it against the code alone first**, and only then compare with what the project says. The order matters: the claim seen first sets the expectation the probe is then read against.

In the study that measured this, an explicit instruction to disregard the framing recovered 94% of the detections it had suppressed. This section is that instruction. It is cheap and it works — but only if it is applied while reading, not recalled afterwards.

## Decision Gates

Gates propose; they do not decide. Render each module as `suggested` or `not applicable (reason)`, then ask.

The `Reference` column is the exact filename under `references/` — load that file and nothing else.

| Gate signal | Module | Reference |
|---|---|---|
| Always proposed (no detection needed) | Functional | `functional.md` |
| | Product | `product.md` |
| | Goal | `goal.md` |
| | Future | `future.md` |
| | Reachability | `reachability.md` |
| | Flow Integrity | `flow-integrity.md` |
| | Complexity | `complexity.md` |
| | Consistency | `consistency.md` |
| | Documentation | `documentation.md` |
| | Prompt/Spec Gap | `prompt-spec-gap.md` |
| Linter, formatter, type-checker, test-runner, or scanner config present **or conspicuously absent** | Tooling Baseline | `tooling-baseline.md` |
| **User enabled execution** — never proposed by detection alone, see `## Execution` | Runtime | `runtime.md` |
| **User enabled browser observation, a browser tool is present in the session, and a target URL exists** — never proposed by detection alone, see `## Execution` | Browser | `browser.md` |
| Project is a git repository | Repo History | `repo-history.md` |
| Statically or gradually typed language | Type Safety | `type-safety.md` |
| Server framework or API routes present | Backend | `backend.md` |
| | API | `api.md` |
| Enumerated states, a status column, or a state library | State Model | `state-model.md` |
| Two surfaces in one repo, or shared types across them | Cross-Surface Parity | `cross-surface-parity.md` |
| Dates, schedules, expiry, or scheduling logic present | Temporal | `temporal.md` |
| Monetary, quantity, or unit-bearing fields present | Numeric & Money | `numeric.md` |
| Retries, webhooks, queues, or externally-triggered writes | Idempotency | `idempotency.md` |
| Tenant, organisation, or workspace scoping present | Multi-tenancy | `multi-tenancy.md` |
| Feature-flag SDK or flag registry present | Feature Flags | `feature-flags.md` |
| Serves HTML to a browser | Web Metadata | `web-metadata.md` |
| User-facing product — analytics SDK present **or conspicuously absent** | Product Analytics | `analytics.md` |
| UI framework present | Frontend | `frontend.md` |
| | Design System | `design-system.md` |
| | Visual Design | `visual-design.md` |
| | Accessibility | `accessibility.md` |
| **Browser observation ran, and a UI framework or HTML entry point was detected** — never proposed by detection alone, see `## Execution` | Usability | `usability.md` |
| Native mobile project | Mobile | `mobile.md` |
| Schema, migrations, or ORM present | Database | `database.md` |
| LLM / AI SDK calls present | AI | `ai.md` |
| Hot path or measurable workload | Performance | `performance.md` |
| Queue, worker, or background jobs | Scalability | `scalability.md` |
| | Concurrency | `concurrency.md` |
| Auth, external input, or network boundary | Failure | `failure.md` |
| | Security | `security.md` |
| | Abuse | `abuse.md` |
| PII or user data persisted | Privacy | `privacy.md` |
| CI/CD, Dockerfile, or IaC present | DevOps | `devops.md` |
| | Infrastructure | `infrastructure.md` |
| Logging / metrics / tracing present **or conspicuously absent** | Observability | `observability.md` |
| Published package manifest or release workflow | Packaging | `packaging.md` |
| | Versioning & Compatibility | `versioning-compatibility.md` |
| Lockfile or dependency manifest present | Dependencies & Licensing | `dependencies-licensing.md` |
| | Supply Chain | `supply-chain.md` |
| LLM / AI SDK calls, or metered cloud usage | Cost | `cost.md` |
| Test files present **or conspicuously absent** | Testing | `testing.md` |
| Locale files or translation keys present | i18n | `i18n.md` |
| OpenAPI, GraphQL, protobuf, or shared types | Contract Drift | `contract-drift.md` |

The absence gates (`Observability`, `Testing`, `Design System`, `Type Safety`, `Product Analytics`) fire in both directions on purpose: "this project has no tests at all" is a finding, not a reason to skip the module. The same holds for a UI with no declared token source — that is the module's headline finding, not a reason it cannot run.

### Establishing each signal

`get_architecture` covers only the manifest-derived signals. Everything else needs a probe, so run these rather than improvising — an improvised gate is a different answer on every run.

| Signal | How to establish it |
|---|---|
| Server framework / API routes | `get_architecture` frameworks; else `search_code` the route-registration call |
| UI framework | `get_architecture` frameworks; else `search_code` for a component file extension (`.tsx`, `.vue`, `.svelte`) or a stylesheet entry point — a project can render UI without a framework in the manifest |
| Styling system and token source | `search_code` for `tailwind.config`, `@theme`, `:root {`, `--color-`, `tokens.json`, a theme module, or the platform theme type — **absence fires the `Design System` gate rather than skipping it**, since "no declared design vocabulary" is the strongest finding that module can return |
| Native mobile project | `search_code` for `AndroidManifest.xml`, `Info.plist`, `pubspec.yaml`, `*.xcodeproj` |
| Schema / migrations / ORM | `search_code` for a migrations directory, `schema.sql`, or an ORM dependency |
| LLM / AI SDK calls | `search_code` the provider SDK import |
| Metered cloud usage | cloud SDK imports in the dependency manifest |
| Queue / worker / background jobs | `search_code` the queue or scheduler dependency, or a worker entry point |
| Auth, external input, network boundary | any one of: a route table, auth middleware, an outbound HTTP client |
| CI/CD, Dockerfile, IaC | `search_code` for workflow files, `Dockerfile`, `*.tf`, `*.yaml` in a deploy path |
| Logging / metrics / tracing | `search_code` the logger or metrics import — **absence fires the gate too** |
| Test files | `search_code` the test-runner config or `*.test.*` — **absence fires the gate too** |
| Published package manifest / release workflow | manifest from `get_architecture`, plus a release workflow file |
| Lockfile / dependency manifest | `get_architecture` packageManager and manifest |
| PII or user data persisted | schema and model field names — email, phone, address, name, date of birth, government id — plus any free-text column |
| Locale files / translation keys | `search_code` for a locales directory or the translation function |
| OpenAPI / GraphQL / protobuf / shared types | `search_code` for `openapi`, `.graphql`, `.proto`, or a shared-types package |
| Hot path or measurable workload | `repo_map`'s top-ranked symbols, plus any loop over unbounded input |
| Browser tool present in the session | probe the session's tool names for `chrome-devtools`, `playwright`, or `claude-in-chrome` tools — nothing is installed; absence renders `Browser` as `not applicable (no browser tool in session)`. This is recorded even when observation stays off, so the offer can name the tool it would use |
| Runnable commands the project declares | manifest scripts, CI workflow steps, and documented commands in the README. This establishes what `Runtime` *could* run and is worth recording even when execution stays off — a project that declares none cannot be verified by running it, which is itself worth saying |
| Tooling configuration | `search_code` for the tool config filenames of the detected stack — linter, formatter, type checker, test runner, pre-commit framework, scanner. **Absence fires the gate**: a project whose tooling checks nothing is one where every defect this audit finds was invisible to automation, and that changes which other modules are worth running |
| Git repository | a `.git` directory — the module reads history, so a shallow clone is `undetermined`, not `not applicable` |
| Statically or gradually typed language | `get_architecture` language, plus a type-checker config (`tsconfig.json`, `mypy.ini`, `pyrightconfig.json`, `go.mod`) — the module audits the *escape hatches* from that checker, so a language with no checker configured is itself the finding |
| Enumerated states / status column | `search_code` for an enum or union of state names, a `status`/`state` column in the schema, or a state-machine library import |
| Two surfaces in one repo | two of {client bundle, server entry point, mobile target} in one tree, or a shared-types package consumed by more than one |
| Dates, schedules, expiry | `search_code` for the date library import, `now()`, `Date(`, a cron expression, or an `expires_at`-shaped column |
| Monetary / unit-bearing fields | schema and type field names — price, amount, total, balance, fee, plus any field carrying a unit (bytes, ms, km, kg) |
| Retries, webhooks, externally-triggered writes | a retry helper, a webhook route, a queue consumer, or a payment SDK |
| Tenant / organisation scoping | a `tenant_id`/`org_id`/`workspace_id` column or an equivalent scoping parameter threaded through queries |
| Feature-flag SDK or registry | `search_code` the flag SDK import, or a flags/config module whose keys gate branches |
| Serves HTML | a template directory, an SSR framework, a static-site generator, or an `index.html` entry point |
| Analytics SDK | `search_code` the analytics or product-telemetry SDK import — **absence in a user-facing product fires the gate too** |

**A signal you cannot establish is `undetermined`, never `not applicable`.** Say which probe was inconclusive and let the user decide. Reporting an unestablished signal as not-applicable silently drops a module they may have needed, and they have no way to know it happened.

## Execution Steps

1. Discovery — stack, architecture, feature map, via the routing table.
2. Apply gates → proposed module set with per-module rationale.
3. **Present the proposal and wait for confirmation.** Report the token implication of the chosen set.
4. **Offer `Runtime` separately, after the module set is settled, and wait.** State that enabling it executes the project's code on this machine, list the declared commands it would run, and name the ones it will not touch. Declining is normal and costs only the `executed` tier. Never fold this into step 3 — a user confirming twenty static modules has not consented to run anything.
   - **4b. Offer `Browser` separately, after `Runtime`, and wait.** Only when a UI or HTML entry point was detected and a browser tool is present. Name the target URL and where it came from, the tool filling the walker and measurer roles, whether any role runs in the user's real browser session, the candidate flows (up to five, ranked by product centrality), and the total pass count. Wait for the flow list to be confirmed before any browser opens. Declining costs only the `observed` tier.
5. For each confirmed module, read only its `references/<module>.md`, then verify against real code — project-brain first, `Read` only to confirm lines it points at. **Run the probe each check names.** A check whose probe was not run produces no finding, not an `inferred` one.
6. Collect findings using the schema above, each with its evidence tier and its ruled-out alternative. Leave `Refutation` empty; step 8 fills it.
7. **Present the Refutation Manifest and wait** — findings collected, how many are eligible at Medium or above, how many are left raw below threshold, how many refuters that means, and the resolved mode with model ids where they are known. Answers are `all`, `critical+high only`, or `none`. A user who replied `refute all` at step 3 has pre-authorised it; print the manifest as a notice and continue. `none` stamps every finding `declined by user` — it does not silently skip the stage.
8. Refute. One subagent per eligible finding, fresh context, the brief and nothing else. Escalate to a second refuter only on `undetermined` at Critical or High, telling it which probes were already inconclusive.
9. Apply the verdicts: drop `refuted` findings into the ledger, reduce `weakened` ones to the severity the refuter named, cap `undetermined` at Medium, and record the mode on every finding. Deduplicate here — the refuters could not, having each seen one finding.
10. Record every module's `Out of static reach` items that mattered — they become Coverage Gaps, not silent omissions.

## Output Contract

In this order: Executive Summary, Project Discovery, Architecture Summary, Feature Map, Modules Run (and why each was skipped), Findings by Severity, Wiring & Reachability Report, Browser Observation Report (only when `Browser` ran), Design System Health (only when `Design System` ran), Coverage Gaps, Refutation Ledger, Technical Debt, Security Risks, Missing Features, Architectural Risks, Recommendations, Quick Wins, Long-term Improvements.

Findings are grouped by severity, and within a severity, ordered by evidence tier — `executed`, `observed`, and `traced` first, then `read`, then `inferred`, with `undetermined` last inside each tier. A reader who stops after the first three findings should have stopped at the three best-proven ones, and the three that survived the hardest attempt to destroy them.

The Executive Summary carries one line naming the refutation mode, both model ids where they are known, how many findings were refuted, and how many were left raw below threshold. It qualifies every number underneath it, so it goes at the top and not in a footnote. In `self-review` mode it says plainly that no adversarial stage ran.

**Browser Observation Report** is one table per flow: the steps walked, the artefacts produced with their paths, the vitals with median and range and the `cold, n=3` or degraded label, the tool that filled each role with its version where exposed, and the steps the measurer could not replay. It says which flows ran in an isolated context and which, if any, ran in the user's real session.

**Refutation Ledger** is the findings that were killed — one line each, and the header states they are not findings. It exists so the user can audit the refuter: a ledger of thin grounds means the kill stage is over-killing, and they can override it. Coverage Gaps is what the audit could not reach; the Ledger is what it reached and dismissed. Adjacent for a reason.

**Design System Health** is a table, not prose: one row per category — colour, spacing, radius, typography, shadow, z-index — with token references, hardcoded literals, and the adoption percentage. It is a tracked number the user can re-measure next quarter; a paragraph of impressions is not. Categories the project does not use are `n/a`, never 100%.

Never invent issues — every finding is backed by repo evidence. Visual quality has a hard static ceiling: the modules say what the code determines and list the rest under Coverage Gaps. An aesthetic verdict with no evidence behind it is the one failure mode this audit cannot recover from, because the user has no way to tell it apart from a real finding.

## SARIF Emission (optional)

Prose is the default and remains the default — most readers of this audit read the report themselves, and turning SARIF on does not change or replace a single line of the Output Contract above. SARIF is an additional, opt-in artefact for teams that want findings in code scanning: pass `--sarif <path>` (or the session equivalent) to also emit a SARIF 2.1.0 document alongside the prose report.

- One `rules[]` entry per **check** (the reference file's checklist item, not per module and not per finding instance), id `brain-audit/<module>/<check-slug>`.
- Severity maps Critical/High → `level: error`, Medium → `level: warning`, Low → `level: note`, Info → `level: none`. SARIF's four-value `level` cannot distinguish Critical from High; for security-relevant categories attach rule-level `properties["security-severity"]` (GitHub's own 0-10 banding) to recover the distinction — for everything else, the distinction survives only in `properties.brainAudit`, and that limitation is stated, not hidden.
- Evidence tier, confidence, refutation verdict and mode, category, severity, business impact, technical impact, recommendation, priority, and ruled-out alternatives travel verbatim in `result.properties.brainAudit` — the Evidence Contract is carried into SARIF, never re-derived or summarised.
- `partialFingerprints["brainAuditFingerprint/v1"]` hashes rule id + normalised file path + the finding's quoted evidence anchor or traced symbol name — never line number alone — so a re-run against unchanged code reproduces the same result identity and an unrelated line shift does not spuriously reopen a closed alert.
- **`inferred`-tier findings are excluded from SARIF emission by default.** A code-scanning UI presents every alert with equal authority, and an `inferred` finding is by definition an unproven hypothesis — that channel is the wrong place for it. A separate, explicit flag may include them, forced to `level: note` and a `-hypothesis`-suffixed rule id regardless of prose severity; this is not the default and is not recommended as a default team practice.
- Findings that were `refuted` never reach SARIF. The Refutation Ledger is prose; a killed finding is not an alert.

## References

One file per module under `references/`. Load only confirmed modules.
