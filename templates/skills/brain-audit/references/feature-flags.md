# Feature Flags

Does every flag still do something, and does everything that should be flagged actually check one? Gate: a feature-flag SDK or flag registry was detected.

Flags are meant to be temporary — a way to ship dark, roll out gradually, or kill something fast. In practice they accumulate, and a stale flag is worse than dead code: it looks like a decision point when it's actually settled, and nobody can tell which without checking every environment. This module inventories the flag surface and finds the two failure modes that matter most: a flag nobody reads, and code that reads a flag nobody declared.

## Build the inventory

- [ ] `search_code` the flag SDK's accessor call (`isEnabled(`, `useFlag(`, `flags.get(`, or the project's own wrapper) and the flag registry/config file if one exists. Enumerate every flag key referenced anywhere in the codebase — this list is the yardstick for every check below.
- [ ] For each flag key, `find_callers` on the accessor call site (or `search_code` the literal key string) to get every read location.
- [ ] Record, per flag: where it's read, what environments set it, and — if the registry stores it — its declared owner and any recorded creation/expiry date.

## Classify by type

- [ ] Classify each flag into Pete Hodgson's four categories — Release, Experiment, Ops, Permissioning; the canonical taxonomy (martinfowler.com/articles/feature-toggles.html) — using its name, any comment at the declaration, and where it's read: a flag gating a UI variant or an unfinished code path reads as **Release**; a flag driving cohort or variant routing reads as **Experiment**; a flag read in an error-handling, degraded-mode, or resource-limiting path reads as **Ops**; a flag read alongside a subscription, role, or entitlement check reads as **Permissioning**. This classification is the yardstick for every check below: the four categories differ deliberately in expected lifespan — Release days to weeks, Experiment until statistical significance, Ops sometimes permanent by design (a kill switch), Permissioning legitimately years — so "this flag is old" is only a finding for the categories where old is not the design.

## Flags with no reader

- [ ] A key declared in the flag registry, config, or provider dashboard export (if checked into the repo) with zero read call sites anywhere in the code. `search_code` the exact key string, including string-interpolated forms — dead configuration, harmless but noise that makes the live flags harder to find among it.

## Reads with no declaration — the most damaging defect here

- [ ] The inverse gap, and the one most worth finding: a flag key read in code (`isEnabled('checkout-v2')`) that appears in no registry, no environment file, no provider config anywhere in the repo. Most flag SDKs return a hardcoded default when a key is unrecognized rather than erroring — which means a **typo'd key silently and permanently returns the default forever**, and nothing in the type system or the test suite catches it, because the call succeeds. `search_code` every literal string argument to the flag accessor and cross-check each one against the registry list built above; any string with no exact match is a candidate, but first rule out: the key is computed at runtime (`` `flag-${variant}` ``) rather than a literal, in which case check the possible expansions instead of dismissing it.
- [ ] The same conceptual flag under two different keys on two surfaces — a client key and a server key that were meant to name the same rollout but were typed independently at each call site. `search_code` both and compare intent, not just spelling; these don't diff cleanly the way a typo does, so this one relies on reading the surrounding logic.
- [ ] A key present in the registry that once had readers and no longer does, cross-referenced against `repo-history.md` if run — distinguish this from "never had a reader" above only when the history check is available; otherwise report both under the same no-reader finding.

## Permanently on or off in every environment

- [ ] For each flag, read its value across every environment config file found (`.env.*`, environment-specific YAML/JSON, a provider's exported config). A flag set to the same value in every environment is no longer a decision point — the branch it doesn't select is dead code that nobody will ever exercise again. **Cross-reference `reachability.md`** for the mechanics of confirming the other branch is truly unreachable; report the flag-specific instance here since the flag is the artefact worth naming.
- [ ] Distinguish "permanently on, old branch still present" (report the dead old-branch code) from "permanently off, new branch never shipped" (report the flag as the thing blocking a feature that otherwise looks complete) — the recommendation differs even though the static signature looks similar.

## No recorded owner or removal date

- [ ] Flags with no owner, ticket reference, or expiry recorded anywhere — not in the registry, not in a comment at the call site, not in the PR that introduced it (out of static reach to check history depth beyond what `repo-history.md` already covers). A flag with no removal criterion is a flag that will never be removed — flag removal belongs in the definition of done, the same way the feature it gates does. Report the count, not each one individually, unless a specific flag is unusually old or risky per the checks below.
- [ ] Weigh the missing owner/expiry by the type classified above: on a **Release** or **Experiment** toggle, no expiry after weeks of history (cross-reference `repo-history.md`) is the real finding — those categories are supposed to be short-lived by design. On an **Ops** kill switch or a **Permissioning** toggle, a long lifespan with no expiry is expected, not a defect on its own; missing an *owner* is still worth flagging there, missing an *expiry* usually isn't.

## Untested or impossible combinations

- [ ] Where two or more flags gate the same code path or adjacent paths, enumerate the combinations actually possible (`search_code` both accessor calls in the same function/module) and check whether any combination is structurally impossible to reach — e.g. flag B's check is nested inside a branch that flag A's default value never enters. This is a `traced`-tier finding only when you can show the nesting; otherwise it's `inferred` and capped at Medium.
- [ ] No test file exercises more than the all-on/all-off combination when 3+ flags interact — `search_code` for the flags near test setup/mocking; an absence here is worth naming even though it caps at Medium as an absence-only finding.

## Partially-shipped features

- [ ] A flag gating only one half of a feature — e.g. the new UI is behind the flag but the backend change it depends on shipped unconditionally (or vice versa). If the flag is ever flipped off after being on, the half that shipped unconditionally is now orphaned with no way back. Cross-reference `flow-integrity.md`'s half-wired-feature table — the pairing check there is the same shape, this module just adds "…and is one of the halves actually reachable only via a flag."

## Evaluated at load time instead of call time

- [ ] `search_code` the accessor call site's context: if it's assigned to a module-level constant or read once during initialization/startup rather than inside the function that uses it, the value is frozen for the process lifetime. This defeats runtime flag flips (kill switches, gradual rollouts) — the deployment has to restart before the new value takes effect, and nobody watching the dashboard toggle would know that.
- [ ] Where the SDK call itself takes an inline default (`isEnabled('x', { default: true })`), diff that inline default against the value declared in the registry's own default. Two different fallback values mean the flag has two different "off" states depending on whether the call reaches the provider or falls back locally — and the local one only fires exactly when the provider is unreachable, the least-tested path.
- [ ] Percentage-rollout or user-targeting logic computed by hand in application code (a modulo on a user ID, a locally seeded random) instead of deferred to the flag provider. Hand-rolled bucketing commonly re-randomizes on each evaluation rather than being stable per user, producing a flag that flips on and off for the same person across page loads — read the bucketing function for whether its input is stable.

## Kill switches that don't actually kill anything

- [ ] For any flag named or documented as a kill switch / circuit breaker, `trace_path` from the flag read to the work it's meant to stop. A kill switch that only suppresses a UI element while the backend job it was meant to halt keeps running (or vice versa) fails exactly when someone needs it most — during an incident, under pressure, trusting that flipping it worked.

## Vendor lock-in via a split evaluation surface

- [ ] If an OpenFeature SDK is present — `search_code` for `@openfeature/`, `openfeature-sdk`, or a `getProvider`/`OpenFeatureClient` call (the spec is at v0.9.0, CNCF Incubating, with provider support from LaunchDarkly, Flagsmith, Unleash, Split, and others) — confirm application code evaluates flags through it consistently, rather than mixing it with direct calls to the underlying vendor SDK. `search_code` for a vendor-specific import (a LaunchDarkly or Unleash client package, say) used for flag reads alongside `@openfeature/*` in the same codebase. A split surface means half the flags can't move to another provider without an application-code rewrite, which defeats the reason to adopt the standard. Absence of OpenFeature entirely is not itself a finding — the spec is still pre-1.0 and plenty of mature flag setups predate or bypass it.

## Security- and billing-relevant flags — stricter bar

- [ ] Any flag gating an authorisation decision, a paywall, a rate limit, or a pricing/billing calculation gets every check above applied without the usual benefit of the doubt: no owner/expiry is a **High** here, not the usual Low-severity noise finding, because a forgotten flag on this class of code is either a security hole (auth bypass left on) or a revenue leak (paywall left off) rather than a housekeeping annoyance.

## Out of static reach

- The actual value a flag holds in a live environment dashboard not checked into the repo.
- Rollout percentages and targeting rules configured only in a third-party provider's UI.
- Whether a flag's owner, if recorded, is still at the organisation or the ticket still open.
- Runtime evaluation order when multiple flag providers or a fallback chain is involved.
- Whether an OpenFeature provider abstraction is actually load-bearing — this module can confirm the call sites are consistent, not that a provider swap has ever been exercised.

## Severity guidance

| Situation | Severity |
|---|---|
| Flag read with no matching declaration (typo'd key, silent default) | High (Critical if security/billing) |
| Kill switch that doesn't stop the work it claims to | Critical |
| Client-only or server-only half of a security/billing flag | High |
| Flag evaluated at load time, defeating a runtime kill switch | High |
| No owner/expiry on a security- or billing-relevant flag | High |
| No expiry on a Release or Experiment toggle past its expected short lifespan | Medium |
| Permanently off flag blocking an otherwise-complete feature | Medium |
| Permanently on flag with the old branch still present (dead code) | Medium |
| Untested flag combination, structurally reachable | Medium |
| No owner/expiry on an Ops or Permissioning flag (owner still expected, expiry may not be) | Low |
| Flag evaluation split between OpenFeature and a direct vendor SDK call | Low |
| Declared flag with zero readers | Low |
