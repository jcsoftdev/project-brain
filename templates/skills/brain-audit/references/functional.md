# Functional

Does the software actually do what it claims to do? This module audits behaviour against stated intent — README, docs, specs, tests, and the names the code itself uses.

## Claimed vs. real behaviour

- [ ] Every capability the README/docs advertise exists in code. `search_code` the feature's name or the exact phrase used in the doc, then `find_symbol` on what it points at. A documented feature with no implementation is `High`. (Cucumber (SmartBear), "BDD," official documentation — https://cucumber.io/docs/bdd/)
- [ ] Every CLI command, flag, subcommand, or public entry point listed in docs is reachable from the real dispatcher. Confirm with `trace_path` from the entry point to the handler.
- [ ] The inverse: capabilities that exist in code but appear in no doc. `search_code` the exported symbol or command string across the docs directory — zero hits confirms it. Rule out: deliberately unlisted internal/admin command, or a feature shipped behind a flag pending announcement. Undocumented and unruled-out ⇒ candidate for the `Reachability` module.
- [ ] Names do not lie. `find_symbol` the function, then read its body against its name: a `validateUser` that only checks non-null, a `cache` that never evicts, a `retry` with one attempt. Naming drift is `Medium` — it misleads every future reader.
- [ ] Where feature files exist (`search_code` for `.feature` files or step-definition directories), `find_callers`/`trace_path` from each step definition to the production entry point it claims to exercise. A step definition that stubs, mocks past, or never calls the real entry point makes its scenario a decorative spec — the same defect class as "documented capability with no implementation," one layer deeper because it looks executed. Rule out a scenario tagged pending/skipped (`@wip`, `@skip`) whose test-runner report marks it not-run — that is an honest gap, not a false claim. (Cucumber (SmartBear), "BDD," official documentation — https://cucumber.io/docs/bdd/; Fowler, "SpecificationByExample," martinfowler.com bliki — https://martinfowler.com/bliki/SpecificationByExample.html)
- [ ] For a capability confirmed present by the README/docs-to-code check above, `find_callers` the entry point to locate its test(s) and read whether the test invokes the entry point with its real collaborators or replaces every collaborator with a mock/stub such that the assertion cannot fail even if the documented behaviour regresses. Rule out a mocked collaborator that is a genuinely external, non-deterministic system (third-party API, payment gateway) — a fake over the real dependency there is not a defect. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 11 — https://abseil.io/resources/swe-book/html/ch11.html)

## Input handling

- [ ] Each public entry point states what it accepts and rejects the rest. `find_symbol` the entry point and read its parameter validation. Missing validation at a trust boundary escalates to the `Security` module. (OWASP, "Input Validation Cheat Sheet" — https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [ ] Boundary values are handled: empty string, empty collection, zero, negative, max int, unicode, very long input. Read the validation function's guard clauses — an entry point with none of these is the finding, not each missing case individually. (OWASP, "Input Validation Cheat Sheet" — https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [ ] Optional parameters have a defined default, and the default is the safe one. `find_symbol` the signature; a parameter typed optional with no explicit default is the finding.
- [ ] Malformed input produces an actionable error, not a stack trace and not silence. `search_code` the entry point's error path (try/catch, `Result`, error return). Rule out a global error-handler/middleware that catches upstream of this function before reporting silence — check its behaviour too, not just the local absence. Whether the resulting message reads as actionable to a real user is out of static reach. (OWASP, "Error Handling Cheat Sheet" — https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html)
- [ ] Where an entry point's validation is confirmed present (the check above), `Read` the validation logic's shape: a denylist/blocklist (reject specific bad characters or values) rather than an allowlist (accept only known-good shapes) is a weaker-than-best-practice pattern, distinct from and additional to validation being absent entirely. Rule out a denylist targeting a closed, fully-enumerable set (e.g., a fixed internal enum) where allowlist and denylist are mathematically equivalent. (OWASP, "Input Validation Cheat Sheet" — https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)

## Output correctness

- [ ] Return shapes are consistent across the success paths of the same function. `find_symbol` the function and read every `return`. A function returning `T | null | undefined | []` for "nothing" has three ways to be wrong at every call site.
- [ ] Errors are distinguishable from valid empty results. `find_callers` the function, then read one call site: can it tell "empty" from "failed" without inspecting an exception?
- [ ] Side effects match the name: `find_symbol` a function named as a query (`get`, `list`, `find`, `is`) and read its body for writes. Rule out an internal memoisation/cache write that has no externally observable effect — that is not the side effect this check targets. A query that mutates externally visible state is `Medium`. For each HTTP entry point registered under GET, HEAD, or OPTIONS (`search_code` the router registration), `find_symbol` the handler and read its body for a write to a datastore, a queued side-effecting job, or an externally observable mutation — a safe-method handler with such a write violates the method's own semantics, independent of whether it is also named like a query. Rule out request logging or an internal counter with no externally observable effect on resource state — RFC 7231's Safe Methods section carves this out: a method whose defined semantics are essentially read-only "is considered safe," and per-request logging is not the kind of state change that carve-out is about. (Fowler, "CommandQuerySeparation," martinfowler.com bliki — https://martinfowler.com/bliki/CommandQuerySeparation.html; IETF, RFC 7231 §4.2.1 — https://www.rfc-editor.org/rfc/rfc7231#section-4.2.1)

## State and idempotency

- [ ] Operations advertised as idempotent have a static marker that would make them so: an upsert instead of an insert, a check-before-write, an idempotency key threaded through the call. `find_symbol` the operation and read for one of these. Rule out dedup enforced by a caller outside this function (a queue consumer, an API gateway) before reporting its absence as a gap. Its absence with no such caller-side guarantee, on an operation the docs call idempotent, is the finding — whether it actually converges under a real re-run is execution, and belongs to `Out of static reach`. For each entry point that performs a create/charge/send/provision operation reachable over a network boundary (external API call, payment, email, queue publish), `search_code`/`find_symbol` for a client-supplied idempotency-key or dedup-token parameter threaded from the request through to the write — its absence on an operation whose caller could plausibly retry after a timeout is the finding, narrower and more concrete than the general static-marker case above. Rule out retry-dedup handled entirely by a caller-side gateway/queue consumer outside this function, or a write that is a pure overwrite naturally idempotent without needing a key. (Stripe, "Idempotent requests," official API documentation — https://docs.stripe.com/api/idempotent_requests; IETF, RFC 7231 §4.2.2 — https://www.rfc-editor.org/rfc/rfc7231#section-4.2.2)
- [ ] Re-entrant / re-run paths (setup, init, sync, migrate) preserve existing user data rather than clobbering it, unless overwrite is the documented contract. `find_symbol` the entry point and read for an existence check before the write.
- [ ] Partial failure leaves recoverable state — no half-written config, no orphaned rows left behind by an operation that failed midway. The general lock/resource-release probe (`search_code` a lock/file acquire and confirm every return path releases it, ruling out a release in a `finally`/`defer` before reporting a leak) is `concurrency.md`'s check; this module's angle is narrower — read the error path and confirm the partial state itself is resumable or cleanly discardable, not that the lock was released.

## Behavioural gaps

- [ ] For each core feature's non-CRUD lifecycle verbs specifically, `search_code` for one with a natural inverse that has no entry point — a `start` with no `stop`, a long-running action with no `cancel`, a destructive action with no `undo`, a creating action with no `dry-run`/preview mode. Anchor each to the entry-point file that would need to grow it; cross-reference `product.md`'s onboarding path. Plain create/read/delete coverage is the next check's territory, not this one's.
- [ ] Every "create" has a matching way to see and remove what was created, or the omission is documented as deliberate. `search_code` the resource name alongside `create`/`delete`/`list` verbs — a verb with no counterpart is the finding.
- [ ] Configuration that can be set can also be read back and reset. `find_callers` the config setter and confirm a getter and a reset/clear path exist in the same module.

## Evidence discipline

Follow the Evidence Contract in `SKILL.md` — every finding here declares its tier and cites `file:line`. "This feature seems incomplete" with no probe run against it is `inferred` at best, and caps at `Medium` regardless of how serious it looks.

## Out of static reach

- Whether an idempotent-looking operation actually converges when re-run concurrently, or only when re-run serially — this needs a concurrency/load harness exercising the race window between the check and the write under real simultaneous requests, not a single flow or a source read.
- Whether an "actionable" error message reads as actionable to an actual user, versus merely present in the return type.
- Runtime boundary-value behaviour — does the empty-string path really take the branch the code implies — closed by `runtime.md` when execution is enabled: cross-reference its coverage run against the guard clause's line to see whether the branch was exercised.
- Partial-failure recovery under a real crash mid-write, as opposed to the presence of a release path in source.
- Whether an inconsistent return shape is actually mishandled by a specific caller at runtime — this module proves the shape is inconsistent, not that any caller currently gets it wrong.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `steps.md` | Whether an "actionable" error message actually reads as actionable to a user during a confirmed flow, after a deliberately invalid, non-side-effecting submission — refuted if the text, though generic, is the same wording the product intentionally standardizes on for all validation failures | Medium |
| `network.jsonl` cross-referenced with `steps.md`'s step label/intent | A UI action labelled as a view/list ("query") triggers a mutating HTTP request — refuted if the mutating call is a non-essential side channel (analytics/telemetry beacon) unrelated to the labelled action's own resource | High |
| `steps.md` + `network.jsonl` + before/after `screenshots/` diff | A documented capability's UI entry point exists but produces no observable effect (no network call, no DOM change, no console activity) when exercised — refuted if the capability is client-only with no network dependency and its effect is visible in the DOM/screenshot even with an empty `network.jsonl` | High |
| `steps.md` (two identical actions) + `network.jsonl` (request bodies/headers, including any idempotency-key header) + `final-state.md` | Performing the same explicitly-named side-effecting action twice within one flow produces a second resource — only producible when the user has named this a side-effecting flow per the module's consent rule; refuted if the UI itself blocks the second submission (double-submit guard) before any request is sent, since that guard is the marker, not its absence | High |

## Severity guidance

| Situation | Severity |
|---|---|
| Documented capability with no implementation | High |
| Entry point in docs unreachable from the real dispatcher | High |
| Missing validation at a trust boundary (escalate to `Security`) | High |
| Naming drift — behaviour contradicts the name | Medium |
| Query function with externally visible side effects | Medium |
| No idempotency marker on an operation documented as idempotent, and no caller-side dedup | Medium |
| Lock/resource with an unreleased path on some return | Medium |
| Trust-boundary validation is denylist-only rather than allowlist, exclusions ruled out | Medium |
| Capability's only test mocks every real collaborator, assertion cannot fail on regression | Medium |
| BDD/Gherkin step definition stubs, mocks past, or never reaches the production entry point it claims to exercise | High |
| Safe-method (GET/HEAD/OPTIONS) handler with an externally observable state mutation | High |
| Idempotency-key missing on a retryable network-boundary mutation that is irreversible or externally billed (payment, provisioning, send-once) | High |
| Undocumented capability, exclusions ruled out | Low |
| Missing read/remove counterpart to a create | Low |
