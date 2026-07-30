# Complexity

What is harder to change than it needs to be? Complexity is not line count — it is the number of things you must hold in your head to make a correct edit.

Use `repo_map` to find the structurally central symbols, then `impact` on each. **A symbol with a large blast radius and high internal complexity is the riskiest code in the project**, and that combination is what this module is for.

## Structural complexity

- [ ] Functions doing more than one thing. The tell is the name: `and`, `or`, `handle`, `process`, `manage`, or a name that describes the caller rather than the operation.
- [ ] Deep nesting. Three levels of conditionals inside a loop is where off-by-one and missed-branch bugs live. Early returns and guard clauses usually collapse it.
- [ ] Long parameter lists, especially with several of the same type — every call site is a chance to swap two arguments silently.
- [ ] Boolean parameters that select behaviour. `render(true, false)` at the call site tells the reader nothing.
- [ ] Functions whose control flow depends on the *caller's* state rather than their arguments.

## Coupling

- [ ] `impact` on the central symbols: how much of the codebase must be re-verified to change one of them? A high number is not automatically wrong, but it must be intentional.
- [ ] Modules that import from many others. `find_callees` at module granularity.
- [ ] Cyclic dependencies. `trace_path` from a module back to itself — a cycle means neither side can be understood alone.
- [ ] Shared mutable state as a coupling mechanism. Two modules communicating through a global are coupled without an interface.
- [ ] Reaching through an object to its internals (`a.b.c.d`) — that chain is four assumptions.

## Duplication that matters

- [ ] Duplicated *logic*, not duplicated *shape*. Two functions with the same structure and different meaning should stay separate; two encoding the same rule must not.
- [ ] The same business rule expressed in more than one place — a validation, a threshold, a format. `search_code` the literal value.
- [ ] Magic values repeated across files. One named constant, one place to change.
- [ ] Premature deduplication is its own finding: an abstraction with one caller and three parameters that only exist to serve it.

## Cognitive load

- [ ] Names that require reading the implementation to understand. Cross-reference the naming-drift check in `functional.md`.
- [ ] Implicit ordering requirements — "call `init` before `run`" enforced only by convention. Make it structural or check it.
- [ ] Non-obvious code with no comment explaining *why*. Comments restating *what* the code does are noise; a missing *why* on a surprising line is a real gap.
- [ ] Conditionals whose branches are hard to enumerate: nested ternaries, flag combinations, `switch` with fallthrough.

## Dead weight

Report these under `Reachability` rather than here, but look for them while reading: unused parameters, options nothing sets, defensive checks for states that cannot occur, and abstraction layers that only forward.

## Severity guidance

| Situation | Severity |
|---|---|
| High-blast-radius symbol that is also internally complex | High |
| The same business rule duplicated in more than one place | Medium |
| Cyclic dependency between modules | Medium |
| Implicit call-ordering requirement with no enforcement | Medium |
| Deeply nested control flow on a correctness-critical path | Medium |
| Boolean parameter selecting behaviour | Low |
| Surprising line with no explanatory comment | Low |
| Abstraction with one caller | Low |
