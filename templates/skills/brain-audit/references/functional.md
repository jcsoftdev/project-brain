# Functional

Does the software actually do what it claims to do? This module audits behaviour against stated intent — README, docs, specs, tests, and the names the code itself uses.

## Claimed vs. real behaviour

- [ ] Every capability the README/docs advertise exists in code. Confirm with `search_code` on the feature's name, then `find_symbol` on what it points at. A documented feature with no implementation is `High`.
- [ ] Every CLI command, flag, subcommand, or public entry point listed in docs is reachable from the real dispatcher. Confirm with `trace_path` from the entry point to the handler.
- [ ] The inverse: capabilities that exist in code but appear in no doc. Undocumented ⇒ nobody uses it ⇒ candidate for the Reachability module.
- [ ] Names do not lie. A function called `validateUser` that only checks non-null, a `cache` that never evicts, a `retry` with one attempt. Naming drift is `Medium` — it misleads every future reader.

## Input handling

- [ ] Each public entry point states what it accepts and rejects the rest. Missing validation at a trust boundary escalates to the Security module.
- [ ] Boundary values are handled: empty string, empty collection, zero, negative, max int, unicode, very long input.
- [ ] Optional parameters have a defined default, and the default is the safe one.
- [ ] Malformed input produces an actionable error, not a stack trace and not silence.

## Output correctness

- [ ] Return shapes are consistent across the success paths of the same function. A function returning `T | null | undefined | []` for "nothing" has three ways to be wrong at every call site.
- [ ] Errors are distinguishable from valid empty results. `find_callers` returning `[]` must not mean the same thing as "lookup failed".
- [ ] Side effects match the name: a function named as a query does not mutate.

## State and idempotency

- [ ] Operations advertised as idempotent actually are — running twice produces the same end state. Test it, do not assume it.
- [ ] Re-entrant / re-run paths (setup, init, sync, migrate) preserve existing user data rather than clobbering it, unless overwrite is the documented contract.
- [ ] Partial failure leaves recoverable state — no half-written config, no orphaned rows, no lock left held.

## Behavioural gaps

- [ ] For each core feature, list what a user would reasonably expect that is absent. Missing cancel, missing undo, missing dry-run, missing list/inspect for something the tool creates.
- [ ] Every "create" has a matching way to see and remove what was created — or the omission is documented as deliberate.
- [ ] Configuration that can be set can also be read back and reset.

## Evidence discipline

Every finding here cites `file:line`. "This feature seems incomplete" without a line reference is not a finding — it is a hypothesis. Downgrade its confidence and say what you would need to confirm it.
