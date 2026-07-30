# Future

What will hurt six months from now? This module is forward-looking, which makes it the easiest place to invent findings. Every item here must point at code that exists today.

## Extension points

- [ ] Where the project clearly expects to grow (new providers, new commands, new file types), is adding one a single-file change or a shotgun edit? Use `find_callers` on the dispatcher to count the places a new case must be registered.
- [ ] Hardcoded lists that will need an entry per future addition — a switch, a `Set` of names, a manual manifest. Not automatically wrong; a hand-maintained list guarded by a parity test is often better than codegen. Flag the ones with no guard.
- [ ] Interfaces with exactly one implementation. Either the abstraction is speculative, or a second implementation is coming and the seam is real. Say which you think it is.

## Scaling assumptions

- [ ] Loops and data structures that assume small N. Find them, then check what actually bounds N — a config value, user input, or nothing.
- [ ] Anything loaded fully into memory: whole files, whole tables, whole directories. State the input size at which it breaks.
- [ ] Synchronous work on a path that will eventually be called in a loop.

## Lock-in

- [ ] Dependencies on a specific vendor, model, API version, or file format, with no adapter layer. Note the switching cost.
- [ ] Data formats written to disk with no version field. Migrating them later means guessing.
- [ ] Persisted state whose schema has no migration path.

## Deprecation debt

- [ ] APIs, flags, or config keys kept for backwards compatibility with no removal date and no deprecation warning. They will be kept forever by default.
- [ ] Duplicated code paths where one is "the old way" — check with `find_callers` whether the old way still has callers. If not, it is dead (report under `Reachability`); if yes, the migration is unfinished.
- [ ] Pinned dependency versions with a comment explaining a workaround. Verify the workaround is still needed.

## What NOT to report here

Speculative refactors, "this could be more generic", and architecture preferences with no concrete future cost. If you cannot name the change that will be painful and the code that makes it painful, it is not a finding — it is taste.
