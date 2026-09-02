# Database

Schema, queries, and migrations. Gate: a schema, migrations, or an ORM was detected.

The highest-value checks here are the declared-vs-used inverse pairs from `reachability.md`. Run them against the schema specifically — a column code reads that no migration creates is a production crash, and it is invisible to the type checker when the ORM is loosely typed.

## Schema integrity

The database is the only enforcement point every writer passes through — a second application, an ops script, or a migration backfill all bypass application-level validation but not a constraint. An invariant the business genuinely cannot tolerate being violated (uniqueness, a required relationship, a valid enum) belongs here even when the app also checks it for UX; app-only enforcement of a hard invariant is one bypass away from silent corruption, and that is the finding, not a style preference.

- [ ] Every table has a primary key. Read the migration files for a `CREATE TABLE` with no `PRIMARY KEY`/`id` column, or `find_symbol` each model and confirm a primary key field.
- [ ] Foreign keys are declared as constraints, not merely implied by a naming convention. `search_code` for a `_id`-suffixed column and confirm a matching `REFERENCES`/`FOREIGN KEY` in the same migration — a naming match with no constraint is the finding.
- [ ] Nullability is deliberate. `find_callers` on a nullable column's accessor and confirm at least one caller null-checks it; if none do, either the column should be `NOT NULL` or every caller is a latent crash.
- [ ] Enum-like columns are constrained (check constraint, enum type, or lookup table), not free-text. Read the column type in the migration, then `search_code` the value literals used against it — a `VARCHAR`/`TEXT` column code treats as a fixed set of values is unconstrained.
- [ ] Unique constraints exist wherever the code assumes uniqueness. `search_code` for a `.findOne`/`SELECT ... LIMIT 1` filtered on the column, then confirm a `UNIQUE` constraint exists on it in the migration. Rule out first: `find_callers` on the query and Read how each caller uses the result — treated as *the* record (assumes uniqueness) or *a* record (a deliberate "any one matching example" query, no uniqueness assumption) — before flagging the missing constraint.
- [ ] Timestamps record what they claim — created vs. updated vs. deleted — and are timezone-explicit. Read the migration's column type (`TIMESTAMP` vs `TIMESTAMPTZ`/`WITH TIME ZONE`), then `find_callers` on the model's update method to confirm `created_at`/`updated_at`/`deleted_at` are set where their names promise.

## Schema vs. code

- [ ] Every column read or written by code exists in a migration. `search_code` the field name across the codebase, then confirm a migration creates it. **A code reference with no creating migration is `High`** — `search_code` is a text search, not one of the Evidence Contract's `traced`-tier tools, and no structural probe exists to prove a migration's absence, so this check cannot exceed `read`'s ceiling.
- [ ] Every column a migration creates is read or written somewhere. `search_code` the field name; zero hits outside the migration and model definition make it `Low`, but keep the candidate list — stale assumptions cluster around these columns.
- [ ] Model/entity definitions match the migrated schema — types, nullability, defaults. `find_symbol` the model and diff its field declarations against the migration that created the table.
- [ ] Indexes exist for the columns actual queries filter and sort on, and no index exists for columns nothing queries. `search_code` for `WHERE`/`.where(`/`ORDER BY` on a column, then confirm an index migration covers it; the inverse — an index `search_code` finds no matching query for — is the companion finding.

## Query quality

- [ ] No query is built by string concatenation with a value that came from outside. `search_code` for string concatenation or template-literal interpolation immediately adjacent to a query-execution call; this is `High` at `read`. `find_callers`/`trace_path` from an external entry point to the concatenation site, confirming the interpolated value actually originates outside the process, promotes it to `traced`, and `Critical`. Belongs in `Security` too — report it once, cross-reference.
- [ ] No N+1: a query inside a loop over a previous query's results. `find_callees` on the loop body for a second query call, and confirm the outer loop iterates over the first query's result set.
- [ ] `SELECT *` in code that only needs two columns. `search_code` for `SELECT *`/`.select()` with no column list, then `find_callers` to see how few fields the caller actually destructures.
- [ ] Queries that can scan the whole table have a bound, or a stated reason they cannot grow. `search_code` for a query against a large table with no `LIMIT`/indexed `WHERE` clause.
- [ ] Aggregations and counts on large tables are not on a request's hot path. `find_callers` on the handler wrapping a `COUNT`/`GROUP BY` query — a request-path caller with no cache in front of it is the finding.
- [ ] No implicit type coercion defeats an index. `search_code` a `WHERE`/filter comparing a column against a literal of a different type — a `text`/`varchar` column compared to a bare integer, or (MySQL) a string column compared to a numeric literal. Check which side the coercion falls on before flagging it: when the *column* is cast to match the literal, a plain index on that column can't be used; when the *constant* is cast to match the column instead (Postgres does this for `int_col = '123'`), the index still applies.

## Migrations

The safest sequencing for a schema change with more than one deploy in flight is expand → migrate → contract ("parallel change"): add the new shape without touching the old one, dual-run until every writer and reader has moved, then remove the old shape in its own later migration. In practice, the step teams skip is the last one — the contract migration — because the visible benefit already shipped once expand and migrate land, and cleanup has no deadline pulling it forward. An expand-phase artefact (dual-write code, a paired old/new column, a compatibility shim) with no tracked removal is therefore a specific, checkable finding, not a hypothetical one.

- [ ] Migrations are ordered, immutable once applied, and recorded. Read the migrations directory listing for a gap in the sequence, or a timestamp/hash that does not match the tool's recorded checksum, where the tool tracks one.
- [ ] An expand-phase artefact has a tracked contract-phase removal. `search_code` for a dual-write (the old column/field still being written alongside a newer one), a compatibility shim, or an `_old`/`_new`/`_v2`-style column pair, then check for a follow-up migration, ticket reference, or dated TODO that removes it. One with no removal plan anywhere in the repo is the finding this pattern is named for.
- [ ] Every migration is reversible, or its irreversibility is stated — but a `down` that would silently discard the data the forward migration removed is not a real reversal. Read each migration file for a `down`/`Down`/rollback method on a destructive statement; current practice favours roll-forward (a new migration that fixes the mistake) over a `down` that pretends a lossy change is undoable. What matters is not the presence of a rollback method but whether the destructive step is isolated in its own migration — see the next check — so its blast radius is contained even without one.
- [ ] Destructive migrations (drop, rename, narrow a type) are separated from deploys that still read the old shape. Read the migration for `DROP`/`RENAME COLUMN`/type-narrowing statements, then `search_code` for the old column name still referenced elsewhere in the same change.
- [ ] Data migrations are idempotent and bounded. Read the migration for an `UPDATE`/backfill statement with no `WHERE` scoping it and no batching — a single unbounded `UPDATE` over a large table locks it.
- [ ] Migrations run to completion or roll back; there is no half-applied resting state. Read the migration runner/tool config for transactional-DDL support; its absence on a multi-statement migration is the finding.
- [ ] A DDL statement that blocks writes for a full table scan is not run against a table expected to be large when a non-blocking form was available. This is version-dependent. **Postgres (11+):** `ADD COLUMN ... DEFAULT <const>` is safe (no rewrite, catalog-only); a volatile default, a combined `NOT NULL DEFAULT`, or `ALTER COLUMN TYPE` forces a full-table rewrite under `ACCESS EXCLUSIVE`; `SET NOT NULL` skips its scan only (12+) if a validated `CHECK (col IS NOT NULL)` already exists — the safe path is `ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT` (which only takes `SHARE UPDATE EXCLUSIVE`) then `SET NOT NULL`; a bare `CREATE INDEX` blocks writes where `CREATE INDEX CONCURRENTLY` does not. **MySQL:** a trailing `ADD COLUMN` qualifies for `ALGORITHM=INSTANT` (no rebuild) since 8.0.12; `DROP COLUMN` and a non-trailing `ADD COLUMN` only became instant-default at 8.0.29 — before that they use `ALGORITHM=INPLACE`, which rebuilds the table but still permits concurrent DML. `ADD INDEX` supports `ALGORITHM=INPLACE, LOCK=NONE`; most other column type changes fall back to `ALGORITHM=COPY`, which blocks concurrent writes for the full rebuild. Read the migration for the blocking form where the non-blocking one applied, or for an explicit `ALGORITHM`/`LOCK` clause missing entirely — an unspecified algorithm can silently fall back to `COPY`.

## Transactions and integrity

- [ ] Related writes share a transaction. `find_callees` on a function performing more than one write and confirm they sit inside one `BEGIN`/transaction call, not sequential independent calls.
- [ ] Read-modify-write is protected against concurrent execution. `search_code` for a read followed by a write of the same row with no version-column check, row lock, or atomic single statement between them. This is the database-row-scoped read-modify-write check; `concurrency.md` owns the in-process/cache-scoped case of the same defect — cross-reference it, do not re-report a finding already covered there.
- [ ] Cascade behaviour is declared deliberately, not inherited by default. Read the foreign key's `ON DELETE`/`ON UPDATE` clause in the migration; an unstated cascade is `High` at `read`. `find_callers`/`trace_path` from an entry point to the parent row's delete path, confirming the cascade is actually reachable and destructive, promotes it to `traced`, and `Critical`.
- [ ] Soft deletes are respected by every read path. `find_callers` on the model's query method and confirm each includes the `deleted_at IS NULL`/equivalent filter — one caller missing it resurrects deleted data.

## Out of static reach

- Actual query plans (`EXPLAIN`/`EXPLAIN ANALYZE`) — this module reads query and schema source, it cannot execute a query the way a live planner would.
- Real table cardinality — whether "large table" means ten rows or ten million; the migration and query source carry no row counts.
- Actual lock contention and duration under concurrent write load.
- Whether an index is actually used by the planner versus merely present — an unused index looks identical to a used one from source.
- Replication lag and its effect on read-after-write consistency.

## Severity guidance

| Situation | Severity |
|---|---|
| Query built by string concatenation, external origin traced (`find_callers`/`trace_path`) (traced) | Critical |
| Unintended cascade delete (traced) | Critical |
| Query built by string concatenation adjacent to external input, reach unconfirmed | High |
| Unstated cascade behaviour on a foreign key, reachability unconfirmed | High |
| Code reads a column no migration creates | High |
| Applied migration edited in place | High |
| Destructive migration deployed alongside code that reads the old shape | High |
| Read path missing the soft-delete filter | High |
| Read-modify-write on a database row with no atomicity | High |
| Missing index on a filtered column of a growing table | Medium |
| N+1 query | Medium |
| Unconstrained enum-like column | Medium |
| Blocking DDL run against an unbounded table when a non-blocking form exists | Medium |
| Implicit type coercion on the column side of a filter, defeating an index | Medium |
| Column created by a migration that nothing reads | Low |
| Expand-phase artefact with no tracked contract-phase removal | Low |
