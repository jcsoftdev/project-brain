# Multi-tenancy

Is every data access scoped to the right tenant? Gate: tenant, organisation, or workspace scoping present.

`security.md` owns authorisation in general — can this user do this action. This module owns the narrower, more mechanical question underneath it for a multi-tenant system: even for an action a user is allowed to perform, does the query reach only their tenant's rows? Authorisation can be correct and tenant scoping can still be wrong, because they are enforced at different layers and a bypass of one does not imply a bypass of the other.

## Inventory

- [ ] Which isolation model this system uses — silo (each tenant gets its own database/schema), pool (tenants share tables, scoped by a `tenant_id`-shaped column), or bridge (a mix by tier, e.g. pooled web tier over siloed storage). `get_architecture` plus a schema read: one database/schema per tenant is silo; shared tables with a tenant column are pool. This isn't a finding by itself, but it sets what the rest of this module should weight most: a pool-model system has zero isolation beyond correct scoping code, so every check below matters more there than in a silo-model system where a scoping bug is contained to one tenant's own database.
- [ ] Every table's tenant-scoping status — `search_code` the schema/migrations for a `tenant_id`/`org_id`/`workspace_id`-shaped column, and list which tables have one and which do not. For tables without one, confirm they are genuinely global (reference/lookup data, system config) rather than tenant data that was never scoped — a tenant-owned table with no tenant column cannot be scoped by any mechanism below, no matter how careful the query layer is.
- [ ] The parameter's shape is consistent — `search_code` for `tenant_id`, `org_id`, `organizationId`, `workspace_id`, and similar across modules; one identifier type and name used everywhere, not `tenant_id` in one module and `organizationId` in another with a translation layer that could drop it.
- [ ] Unique constraints scoped correctly — `find_symbol` each unique index on a tenant-owned table and check whether the tenant column is part of the key. A global unique constraint on `email` (rather than `(tenant_id, email)`) either blocks a legitimate second tenant from using an address already in use elsewhere, or — if enforced only in application code — is exactly the kind of check the constraint should be enforcing instead.

## Query-level scoping

- [ ] Before flagging any individual query as unscoped, find the repository/ORM layer or query-builder base class first — `search_context` "how are queries scoped to a tenant" or `find_symbol` the base repository. A centralised default scope (an ORM global scope, a query-builder mixin applied everywhere) makes individual unscoped-looking call sites correct by construction; report the *mechanism*, not thirty false positives against it.
- [ ] Once the mechanism is found: does every path that constructs a query for a tenant-scoped table go through it? `find_callers` on the raw query/ORM-model access to catch call sites that bypass the repository layer entirely (direct model access, a raw query builder used inline).
- [ ] Raw SQL anywhere in the codebase — `search_code` for a raw query execution call — is exempt from any ORM-level default scope by definition, so each one needs its own explicit tenant filter, checked by hand.
- [ ] Joins and eager-loaded relations: a primary query correctly scoped to a tenant does not guarantee its joined tables are. `find_symbol` the join/relation definition and confirm the joined table's own tenant filter is applied, not just an implicit assumption that the join key already narrows it.
- [ ] The actual scoping mechanism identified above — request-scoped middleware context, a database row-level security policy, an ORM default scope — and specifically how the tenant identifier gets into it. `find_symbol` the middleware/context setter and read where its value comes from: a client-supplied header or body field (rather than the authenticated session/token) lets a caller assert any tenant they like. OWASP's Multi-Tenant Security Cheat Sheet states this plainly: bind tenant context to the authenticated session, never trust a client-supplied tenant id.
- [ ] Where row-level security (Postgres RLS or equivalent) is the mechanism: RLS has two silent bypasses that make an enabled policy do nothing. `search_code` migrations for `ENABLE ROW LEVEL SECURITY` and check whether the matching `ALTER TABLE ... FORCE ROW LEVEL SECURITY` is also present — without `FORCE`, the table's owner role bypasses every policy on it. Separately, read the application's DB connection configuration for which role it authenticates as — a connection using a superuser role, or any role granted `BYPASSRLS`, skips RLS entirely regardless of what the policies say. Either gap means the policies are dead code for the role that matters.

## Paths with no request context

- [ ] Background jobs and scheduled work — `search_code` the job/worker entry points and check whether each one receives an explicit tenant identifier or iterates tenants explicitly, versus relying on the same request-scoped context used by the web layer, which does not exist in a job runner. This is where tenant scoping is most often silently absent, because the code was written and tested only against the request path.
- [ ] Admin endpoints and internal tooling — `find_symbol` the admin route handlers and read whether tenant selection is an explicit parameter the operator supplies, or inherited from the same scoping code path used for a limited tenant-user, which may not generalise the way an admin tool needs it to.
- [ ] Data exports, report generation, and migrations — `find_callees` from each to confirm tenant filtering happens explicitly rather than being assumed from context that will not be present when the script runs standalone.
- [ ] Webhook and queue-consumer handlers that carry a tenant identifier in the payload — `find_symbol` the handler and confirm it re-derives the tenant from an authenticated/signed source (the subscription record, the API key that registered the webhook) rather than trusting a tenant ID the payload itself supplies, which a forged or misrouted event could set to any value.

## Identifiers

- [ ] Sequential or otherwise guessable IDs (auto-increment integers) used as externally-exposed resource identifiers — combined with any authorisation gap, this permits enumeration across tenants even where scoping is otherwise correct, because the ID itself leaks the existence and ordering of other tenants' records. Cross-reference `abuse.md` for the enumeration/rate-limiting angle; report the identifier choice here.

## Caches

- [ ] Every cache key touching tenant data includes the tenant identifier — `search_code` the cache-set/cache-get call sites for tenant-scoped data and read the key construction. A cache key built from a resource ID alone, with no tenant component, serves tenant A's cached value to tenant B's identical-shaped request. This is the highest-severity finding this module can produce, because it requires no attacker action at all — it fires on ordinary traffic the moment two tenants share a cache-key collision.
- [ ] Where the key does include a tenant component, check whether the cached value itself also carries the tenant identifier and is verified on read. `find_symbol` the cache-read path and confirm it checks the stored `tenant_id` against the expected one, rather than trusting key construction alone — a key-only guard has no second check if the key is ever built wrong at one call site while correct everywhere else.

## Files and cross-boundary data

- [ ] Uploaded files and object-storage paths — `search_code` the upload handler's storage-path/key construction and check whether the tenant identifier is part of the path/prefix itself, or only enforced by an application-level check that a misconfigured bucket policy or a directly-guessed URL bypasses.
- [ ] Logs and error reports carrying tenant data — `search_code` the logger calls near tenant-data handling for full record dumps (rather than IDs) that could surface one tenant's data in another's support ticket or a shared observability tool. Cross-reference `privacy.md` for the general PII-in-logs concern; report the cross-tenant leak angle here.

## Cross-tenant features

- [ ] Sharing, transfer, or impersonation features (an admin "log in as" a tenant's user, moving a resource between tenants) — confirm each one is deliberately scoped and, ideally, audited (`search_code` for an audit-log write alongside the action), rather than being a side door that bypasses the scoping mechanism entirely because it was built as a special case.
- [ ] Test coverage for cross-tenant isolation — `search_code` the test suite for a case that asserts tenant A cannot read tenant B's data. Its absence is itself a finding: a scoping mechanism nobody has written a test to break is a mechanism nobody has verified.

## Out of static reach

- Whether a row-level security policy actually evaluates as expected against live data at runtime — the migration declaring `ENABLE`/`FORCE ROW LEVEL SECURITY` and the connection role's privileges are readable from source (see Query-level scoping above); whether the policy predicate itself is logically correct against real rows is not.
- Real cache collision behaviour under production key distributions.
- Whether a background job's tenant loop actually covers every active tenant in practice.
- Storage bucket/IAM policy configuration outside the repository.

## Severity guidance

| Situation | Severity |
|---|---|
| Cache key for tenant data with no tenant component | Critical |
| Raw SQL or bypassed repository layer with no tenant filter on a tenant-scoped table | Critical |
| Webhook/queue payload's self-declared tenant ID trusted without re-derivation | Critical |
| RLS enabled but not `FORCE`d, or app connects via a role with `BYPASSRLS`/superuser | Critical |
| Background job or scheduled work with no tenant scoping at all | High |
| Tenant identifier sourced from a client-supplied value instead of the authenticated session | High |
| Tenant-scoped table with no tenant column at all | High |
| Joined/eager-loaded relation missing its own tenant filter | High |
| Cross-tenant feature (impersonation, transfer) with no audit trail | Medium |
| Sequential/guessable IDs on tenant-scoped resources | Medium |
| Uploaded file path with no tenant component in storage | Medium |
| Tenant data appearing in full in logs or error reports | Medium |
| Unique constraint scoped globally instead of per-tenant | Medium |
| No test asserting cross-tenant isolation | Medium |
| Inconsistent tenant-parameter naming across modules | Low |
