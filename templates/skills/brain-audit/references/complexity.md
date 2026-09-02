# Complexity

What is harder to change than it needs to be? Complexity is not line count — it is the number of things you must hold in your head to make a correct edit.

Use `repo_map` to find the structurally central symbols, then `impact` on each. **A symbol with a large blast radius and high internal complexity is the riskiest code in the project**, and that combination is what this module is for.

This module never computes a complexity score — no cyclomatic number, no cognitive-complexity number — because that requires running an analyser, and everything here is established by reading. If the project already has one committed (a linter's `complexity` rule, a SonarQube report, a CI badge), read it with the evidence in mind rather than at face value: cyclomatic complexity's correlation with real defects is weaker and more contested than it's often assumed to be — a formal critique (Shepperd, "A critique of cyclomatic complexity as a software metric") argues its predictive power may reduce mostly to code size — while a ceiling on the number (historically 10, sometimes relaxed to 15 with strong review and test discipline) remains a defensible *engineering* limit, which is a different and more modest claim than "this number predicts a bug." Cognitive Complexity (SonarSource, 2016–17) is the better-regarded metric specifically for *readability* — it was designed to fix cyclomatic complexity's blind spot for nesting and mixed boolean chains — but controlled studies still find it only a modest predictor of understandability, not of defects. Treat any such number, from this project or elsewhere, as a structural signal worth a closer read, never as proof on its own.

## Structural complexity

- [ ] Functions doing more than one thing — the tell is the name: `and`, `or`, `handle`, `process`, `manage`, or a name that describes the caller rather than the operation. `search_code` for definitions matching those verbs, then read each to confirm it does more than its name admits.
- [ ] Deep nesting — three levels of conditionals inside a loop is where off-by-one and missed-branch bugs live. Start from `repo_map`'s central symbols and read each; early returns and guard clauses usually collapse it.
- [ ] Long parameter lists, especially with several of the same type — `find_symbol` the signature. Every call site is a chance to swap two arguments silently, so cross-check with `find_callers` whether call sites actually differ only by argument order.
- [ ] Boolean parameters that select behaviour — `search_code` for call sites with adjacent boolean literals (`, true, false)`, `, false, true)`). `render(true, false)` at the call site tells the reader nothing without opening the definition.
- [ ] Functions whose control flow depends on the *caller's* state rather than their arguments — read the function body for a reference to module-level or global state, then `find_callers` to confirm different callers rely on different ambient state to get different behaviour.

## Coupling

- [ ] `impact` on the central symbols: how much of the codebase must be re-verified to change one of them? A high number is not automatically wrong, but it must be intentional.
- [ ] Modules that import from many others — `find_callees` at module granularity, and compare the callee count against its peer modules' median; a count several times its peers' median is coupled to all of them at once. Rule out: a module whose stated role is to aggregate or wire up others (a facade, an orchestrator, a DI container) is expected to import broadly — confirm the module isn't one of these before flagging.
- [ ] Cyclic dependencies — `trace_path` from a module back to itself. A cycle means neither side can be understood alone.
- [ ] Shared mutable state as a coupling mechanism — `search_code` for an exported `let` or a mutable singleton, then `find_callers` on it. Two unrelated modules both writing to it are coupled without an interface.
- [ ] Reaching through an object to its internals (`a.b.c.d`) — `search_code` the deepest access chain seen while reading a central module. Each additional segment is one more assumption the caller makes about the callee's internal shape.

## Duplication that matters

- [ ] Duplicated *logic*, not duplicated *shape*. Two functions with the same structure and different meaning should stay separate; two encoding the same rule must not. Once `search_code` surfaces structurally similar functions (same branch count, same operation order), read both bodies side by side to tell which case you're in.
- [ ] The same business rule expressed in more than one place — a validation, a threshold, a format. `search_code` the literal value (a magic number, a regex, a status string) across the repo; more than one hit outside a shared constant is the finding. Rule out: two hits that coincidentally share the same literal for unrelated purposes (a retry count of 3 next to an unrelated array size of 3) are not the finding — confirm both hits encode the same rule, not merely the same numeric value, before flagging.
- [ ] Magic values repeated across files — `search_code` the literal. One named constant, one place to change.
- [ ] Premature deduplication is its own finding — `find_callers` on the shared abstraction. A count of one caller, plus three parameters that only exist to serve it, is complexity added for a reuse that never happened.
- [ ] An abstraction serving two or more callers that has grown parameters or conditionals existing only to accommodate one caller's divergence — `find_callers` the shared function or component and read what each call site actually needs from it. When the callers no longer share the same *reason* to call it, even though the code path is still shared, this is the wrong abstraction (Sandi Metz, "The Wrong Abstraction," 2016): the fix is to inline it back into each caller and let the duplication return, not add another parameter to keep forcing them together. This is the same smell as the one-caller case above, one caller further along — and more damaging, because it's now a live complexity tax on real call sites instead of unused generality.

## Cognitive load

- [ ] Names that require reading the implementation to understand — predict the function's behaviour from its name alone, then `Read` the body and check the prediction held. Cross-reference the naming-drift check in `functional.md`.
- [ ] Implicit ordering requirements — "call `init` before `run`" enforced only by convention — `find_callers` on the second call to check every call site actually calls the first one first, and whether anything enforces it structurally (a state check, a type that only exists post-init) rather than by convention alone.
- [ ] Non-obvious code with no comment explaining *why* — `Read` the functions `repo_map` and `impact` flag as central. Comments restating *what* the code does are noise; the failure condition is a line that contradicts what the surrounding code implies, a workaround with no linked issue, or a magic exception to an otherwise-consistent pattern, with no comment explaining it — that missing *why* is a real gap.
- [ ] Conditionals whose branches are hard to enumerate — `search_code` for nested ternaries (`? ... ? ... :`) and `switch` statements missing a `break` before the next `case`.

## Dead weight

Report these under `Reachability` rather than here, but look for them while reading: unused parameters, options nothing sets, defensive checks for states that cannot occur, and abstraction layers that only forward.

## Out of static reach

- Whether a high-blast-radius symbol is actually risky in practice, or merely central and rarely touched — call-graph centrality is not change frequency; cross-reference `repo-history.md` for that signal.
- Whether coupling through shared state actually causes incorrect behaviour, which depends on execution order this module cannot observe — closed by `runtime.md`'s repeated and reordered test runs when execution is enabled, which can surface an order-dependent failure tied to this coupling, bounded by what those runs sample.
- Whether a reader genuinely finds a given structure confusing — cognitive load is inferred from shape, not measured from a person.
- Whether an implicit ordering requirement has ever actually been violated in production — closed by `runtime.md`'s repeated (`n/10`) and reordered test runs when execution is enabled, bounded by what those runs sample.
- Whether the same rule reimplemented across services (a validation duplicated in a mobile client, say) is intentional platform divergence or drift — this module sees one repo at a time.
- Whether a reported complexity score (cyclomatic, cognitive, or otherwise) has ever correlated with an actual defect in this codebase specifically — the general research correlating either metric with real-world bug density is weaker than commonly assumed, and settling it here would require the historical defect data this module doesn't have.

## Severity guidance

| Situation | Severity |
|---|---|
| High-blast-radius symbol that is also internally complex | High |
| The same business rule duplicated in more than one place | Medium |
| Cyclic dependency between modules | Medium |
| Module importing far more than its peers, with no aggregator/facade role justifying it | Medium |
| Implicit call-ordering requirement with no enforcement | Medium |
| Deeply nested control flow on a correctness-critical path | Medium |
| Shared abstraction kept alive with extra parameters for callers that no longer agree (the wrong abstraction) | Medium |
| Boolean parameter selecting behaviour | Low |
| Surprising line with no explanatory comment | Low |
| Abstraction with one caller | Low |
