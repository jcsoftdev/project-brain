# Database

Schema, queries, and migrations. Gate: a schema, migrations, or an ORM was detected.

The highest-value checks here are the declared-vs-used inverse pairs from `reachability.md`. Run them against the schema specifically — a column code reads that no migration creates is a production crash, and it is invisible to the type checker when the ORM is loosely typed.

## Schema integrity

- [ ] Every table has a primary key.
- [ ] Foreign keys are declared as constraints, not merely implied by a naming convention. An implied relationship is not enforced by anything.
- [ ] Nullability is deliberate. A nullable column that code never checks for null is a latent crash.
- [ ] Enum-like columns are constrained (check constraint, enum type, or lookup table), not free-text.
- [ ] Unique constraints exist wherever the code assumes uniqueness. `search_code` for the lookup that assumes one row.
- [ ] Timestamps record what they claim — created vs. updated vs. deleted — and are timezone-explicit.

## Schema vs. code

- [ ] Every column read or written by code exists in a migration. **Code reading a column no migration creates is `Critical`.**
- [ ] Every column a migration creates is read or written somewhere. Unused columns are `Low`, but they are also where stale assumptions hide.
- [ ] Model/entity definitions match the migrated schema — types, nullability, defaults. Drift here means the ORM lies to every caller.
- [ ] Indexes exist for the columns actual queries filter and sort on, and no index exists for columns nothing queries.

## Query quality

- [ ] No query is built by string concatenation with a value that came from outside. Parameterised or nothing. This is `Critical` and belongs in `Security` too — report it once, cross-reference.
- [ ] No N+1: a query inside a loop over a previous query's results. `find_callees` on the loop body.
- [ ] `SELECT *` in code that only needs two columns — cheap to fix, and it silently widens every future schema change's blast radius.
- [ ] Queries that can scan the whole table have a bound, or a stated reason they cannot grow.
- [ ] Aggregations and counts on large tables are not on a request's hot path.

## Migrations

- [ ] Migrations are ordered, immutable once applied, and recorded. An edited applied migration means two environments have different schemas with the same version.
- [ ] Every migration is reversible, or its irreversibility is stated.
- [ ] Destructive migrations (drop, rename, narrow a type) are separated from deploys that still read the old shape. A single-step rename breaks every running instance of the previous version.
- [ ] Data migrations are idempotent and bounded — a single `UPDATE` over a large table locks it.
- [ ] Migrations run to completion or roll back; there is no half-applied resting state.

## Transactions and integrity

- [ ] Related writes share a transaction.
- [ ] Read-modify-write is protected against concurrent execution — optimistic version column, row lock, or an atomic single statement.
- [ ] Cascade behaviour is declared deliberately, not inherited by default. An unintended cascade delete is `Critical`.
- [ ] Soft deletes are respected by every read path. `find_callers` on the model — one query missing the `deleted_at` filter resurrects deleted data.

## Severity guidance

| Situation | Severity |
|---|---|
| Query built by string concatenation from external input | Critical |
| Code reads a column no migration creates | Critical |
| Unintended cascade delete | Critical |
| Applied migration edited in place | High |
| Destructive migration deployed alongside code that reads the old shape | High |
| Read path missing the soft-delete filter | High |
| Missing index on a filtered column of a growing table | Medium |
| N+1 query | Medium |
| Unconstrained enum-like column | Medium |
| Column created by a migration that nothing reads | Low |
