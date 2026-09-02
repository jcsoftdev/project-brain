# Functional

Does the software actually do what it claims to do? This module audits behaviour against stated intent — README, docs, specs, tests, and the names the code itself uses.

## Claimed vs. real behaviour

- [ ] Every capability the README/docs advertise exists in code. `search_code` the feature's name or the exact phrase used in the doc, then `find_symbol` on what it points at. A documented feature with no implementation is `High`.
- [ ] Every CLI command, flag, subcommand, or public entry point listed in docs is reachable from the real dispatcher. Confirm with `trace_path` from the entry point to the handler.
- [ ] The inverse: capabilities that exist in code but appear in no doc. `search_code` the exported symbol or command string across the docs directory — zero hits confirms it. Rule out: deliberately unlisted internal/admin command, or a feature shipped behind a flag pending announcement. Undocumented and unruled-out ⇒ candidate for the `Reachability` module.
- [ ] Names do not lie. `find_symbol` the function, then read its body against its name: a `validateUser` that only checks non-null, a `cache` that never evicts, a `retry` with one attempt. Naming drift is `Medium` — it misleads every future reader.

## Input handling

- [ ] Each public entry point states what it accepts and rejects the rest. `find_symbol` the entry point and read its parameter validation. Missing validation at a trust boundary escalates to the `Security` module.
- [ ] Boundary values are handled: empty string, empty collection, zero, negative, max int, unicode, very long input. Read the validation function's guard clauses — an entry point with none of these is the finding, not each missing case individually.
- [ ] Optional parameters have a defined default, and the default is the safe one. `find_symbol` the signature; a parameter typed optional with no explicit default is the finding.
- [ ] Malformed input produces an actionable error, not a stack trace and not silence. `search_code` the entry point's error path (try/catch, `Result`, error return). Rule out a global error-handler/middleware that catches upstream of this function before reporting silence — check its behaviour too, not just the local absence. Whether the resulting message reads as actionable to a real user is out of static reach.

## Output correctness

- [ ] Return shapes are consistent across the success paths of the same function. `find_symbol` the function and read every `return`. A function returning `T | null | undefined | []` for "nothing" has three ways to be wrong at every call site.
- [ ] Errors are distinguishable from valid empty results. `find_callers` the function, then read one call site: can it tell "empty" from "failed" without inspecting an exception?
- [ ] Side effects match the name: `find_symbol` a function named as a query (`get`, `list`, `find`, `is`) and read its body for writes. Rule out an internal memoisation/cache write that has no externally observable effect — that is not the side effect this check targets. A query that mutates externally visible state is `Medium`.

## State and idempotency

- [ ] Operations advertised as idempotent have a static marker that would make them so: an upsert instead of an insert, a check-before-write, an idempotency key threaded through the call. `find_symbol` the operation and read for one of these. Rule out dedup enforced by a caller outside this function (a queue consumer, an API gateway) before reporting its absence as a gap. Its absence with no such caller-side guarantee, on an operation the docs call idempotent, is the finding — whether it actually converges under a real re-run is execution, and belongs to `Out of static reach`.
- [ ] Re-entrant / re-run paths (setup, init, sync, migrate) preserve existing user data rather than clobbering it, unless overwrite is the documented contract. `find_symbol` the entry point and read for an existence check before the write.
- [ ] Partial failure leaves recoverable state — no half-written config, no orphaned rows left behind by an operation that failed midway. The general lock/resource-release probe (`search_code` a lock/file acquire and confirm every return path releases it, ruling out a release in a `finally`/`defer` before reporting a leak) is `concurrency.md`'s check; this module's angle is narrower — read the error path and confirm the partial state itself is resumable or cleanly discardable, not that the lock was released.

## Behavioural gaps

- [ ] For each core feature's non-CRUD lifecycle verbs specifically, `search_code` for one with a natural inverse that has no entry point — a `start` with no `stop`, a long-running action with no `cancel`, a destructive action with no `undo`, a creating action with no `dry-run`/preview mode. Anchor each to the entry-point file that would need to grow it; cross-reference `product.md`'s onboarding path. Plain create/read/delete coverage is the next check's territory, not this one's.
- [ ] Every "create" has a matching way to see and remove what was created, or the omission is documented as deliberate. `search_code` the resource name alongside `create`/`delete`/`list` verbs — a verb with no counterpart is the finding.
- [ ] Configuration that can be set can also be read back and reset. `find_callers` the config setter and confirm a getter and a reset/clear path exist in the same module.

## Evidence discipline

Follow the Evidence Contract in `SKILL.md` — every finding here declares its tier and cites `file:line`. "This feature seems incomplete" with no probe run against it is `inferred` at best, and caps at `Medium` regardless of how serious it looks.

## Out of static reach

- Whether an idempotent-looking operation actually converges when re-run concurrently, or only when re-run serially.
- Whether an "actionable" error message reads as actionable to an actual user, versus merely present in the return type.
- Runtime boundary-value behaviour — does the empty-string path really take the branch the code implies — closed by `runtime.md` when execution is enabled: cross-reference its coverage run against the guard clause's line to see whether the branch was exercised.
- Partial-failure recovery under a real crash mid-write, as opposed to the presence of a release path in source.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `steps.md` | Whether an "actionable" error message actually reads as actionable to a user during a confirmed flow | Medium |

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
| Undocumented capability, exclusions ruled out | Low |
| Missing read/remove counterpart to a create | Low |
