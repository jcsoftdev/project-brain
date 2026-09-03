# Multi-tenancy

Is every data access scoped to the right tenant? Gate: tenant, organisation, or workspace scoping present.

`security.md` owns authorisation in general — can this user do this action. This module owns the narrower, more mechanical question underneath it for a multi-tenant system: even for an action a user is allowed to perform, does the query reach only their tenant's rows? Authorisation can be correct and tenant scoping can still be wrong, because they are enforced at different layers and a bypass of one does not imply a bypass of the other.

## Inventory

- [ ] Which isolation model this system uses — silo (each tenant gets its own database/schema), pool (tenants share tables, scoped by a `tenant_id`-shaped column), or bridge (a mix by tier, e.g. pooled web tier over siloed storage). `get_architecture` plus a schema read: one database/schema per tenant is silo; shared tables with a tenant column are pool. This isn't a finding by itself, but it sets what the rest of this module should weight most: a pool-model system has zero isolation beyond correct scoping code, so every check below matters more there than in a silo-model system where a scoping bug is contained to one tenant's own database. AWS's SaaS Architecture Fundamentals whitepaper: "tenant isolation is separate from general security mechanisms... a user could be authenticated and authorized, and still access the resources of another tenant" — pooled resources need "more fine-grained policies to control access" than dedicated-stack isolation does.
- [ ] Every table's tenant-scoping status — `search_code` the schema/migrations for a `tenant_id`/`org_id`/`workspace_id`-shaped column, and list which tables have one and which do not. For tables without one, confirm they are genuinely global (reference/lookup data, system config) rather than tenant data that was never scoped — a tenant-owned table with no tenant column cannot be scoped by any mechanism below, no matter how careful the query layer is.
- [ ] The parameter's shape is consistent — `search_code` for `tenant_id`, `org_id`, `organizationId`, `workspace_id`, and similar across modules; one identifier type and name used everywhere, not `tenant_id` in one module and `organizationId` in another with a translation layer that could drop it.
- [ ] Unique constraints scoped correctly — `find_symbol` each unique index on a tenant-owned table and check whether the tenant column is part of the key. A global unique constraint on `email` (rather than `(tenant_id, email)`) either blocks a legitimate second tenant from using an address already in use elsewhere, or — if enforced only in application code — is exactly the kind of check the constraint should be enforcing instead. Rule out a deliberately tenant-agnostic identity table (a user account that can belong to more than one tenant) before flagging.

## Query-level scoping

- [ ] Before flagging any individual query as unscoped, find the repository/ORM layer or query-builder base class first — `search_context` "how are queries scoped to a tenant" or `find_symbol` the base repository. A centralised default scope (an ORM global scope, a query-builder mixin applied everywhere) makes individual unscoped-looking call sites correct by construction; report the *mechanism*, not thirty false positives against it.
- [ ] Once the mechanism is found: does every path that constructs a query for a tenant-scoped table go through it? `find_callers` on the raw query/ORM-model access to catch call sites that bypass the repository layer entirely (direct model access, a raw query builder used inline).
- [ ] Raw SQL anywhere in the codebase — `search_code` for a raw query execution call — is exempt from any ORM-level default scope by definition, so each one needs its own explicit tenant filter, checked by hand.
- [ ] Joins and eager-loaded relations: a primary query correctly scoped to a tenant does not guarantee its joined tables are. `find_symbol` the join/relation definition and confirm the joined table's own tenant filter is applied, not just an implicit assumption that the join key already narrows it.
- [ ] Endpoints or resolvers accepting an array of resource IDs (bulk fetch, bulk delete, batch export) — `search_code` for handler signatures taking an ID list, then `find_callees` to confirm the query built from that list carries the same tenant filter as the single-ID path (a `WHERE id IN (...) AND tenant_id = ?`), rather than a query scoped only by the ID list with tenant checked once outside the loop or not at all. A batch query that carries the tenant filter across the whole `IN (...)` set in one statement is correct scoping, not the finding, even though it looks unlike the single-ID pattern. OWASP API1:2023 BOLA requires checking permissions "in every function that uses an input from the client to access a record" — a batch/array endpoint is that function.
- [ ] The actual scoping mechanism identified above — request-scoped middleware context, a database row-level security policy, an ORM default scope — and specifically how the tenant identifier gets into it. `find_symbol` the middleware/context setter and read where its value comes from: a client-supplied header or body field (rather than the authenticated session/token) lets a caller assert any tenant they like. OWASP's Multi-Tenant Security Cheat Sheet states this plainly: bind tenant context to the authenticated session, never trust a client-supplied tenant id. Where tenant context comes from a JWT or session claim, `search_code` the verification step and `find_callers` to confirm every tenant-scoped route calls it before the tenant-context setter runs, then `Read` the verification body itself to confirm it checks the claim against tenant membership for the resource being acted on, not merely that the token carries a validly signed claim — a shared signing key or verification path could accept a token minted for tenant A on a request addressed to tenant B. Structural coverage alone only proves the check runs everywhere, not that it does the right comparison, so a mixed check like this caps at the tier of its weaker half (`read`, not `traced`), per the Evidence Contract.
- [ ] Where row-level security (Postgres RLS or equivalent) is the mechanism: RLS has two silent bypasses that make an enabled policy do nothing. `search_code` migrations for `ENABLE ROW LEVEL SECURITY` and check whether the matching `ALTER TABLE ... FORCE ROW LEVEL SECURITY` is also present — without `FORCE`, the table's owner role bypasses every policy on it (PostgreSQL's own Row Security Policies documentation: "table owners normally bypass row security as well"). Separately, read the application's DB connection configuration for which role it authenticates as — a connection using a superuser role, or any role granted `BYPASSRLS`, skips RLS entirely regardless of what the policies say ("superusers and roles with the BYPASSRLS attribute always bypass the row security system"). Either gap means the policies are dead code for the role that matters.

## Tenant resolution

- [ ] Where tenant resolution derives from the request's Host header, `X-Forwarded-Host`, or a subdomain (the common per-tenant-subdomain SaaS pattern) — `search_code` the tenant-resolution middleware/function for where it reads that value, and confirm it is looked up against a registered tenant/domain table (a miss rejects) rather than trusted directly as the tenant identifier or interpolated into a generated link. A resolved value looked up against a tenant table where a miss is rejected (404/no match) rather than accepted as-is is not this finding — a lookup miss is a different failure mode than trusting the header value directly. PortSwigger's Host header attacks documentation: servers that derive routing or absolute-URL generation from the client-controllable Host header (or `X-Forwarded-Host`) enable password-reset poisoning, web-cache poisoning, virtual-host brute-forcing, routing-based SSRF, and authentication bypass — a per-tenant-subdomain architecture is the multi-tenant instance of this trust pattern.

## Non-relational and search stores

- [ ] Stores queried outside the SQL/ORM layer entirely — a full-text search index, a vector database, an in-memory store queried via its own client library — `search_code` the query-construction call sites against each and confirm the tenant filter is part of that store's own query (a `term`/`filter` clause, a metadata predicate, or a separate index/collection per tenant), not assumed from the request-scoped context that only the SQL layer's central mechanism (found above) actually enforces. A store siloed per tenant at the index/collection-naming level (one index/collection per tenant) needs no query-level filter clause — confirm the naming convention before flagging a missing filter. AWS's SaaS tenant-isolation guidance generalises past SQL tables to any pooled resource; OWASP API1:2023 BOLA's "every function that uses input from the client to access a record" applies equally to a search/vector query function.

## Paths with no request context

- [ ] Background jobs and scheduled work — `search_code` the job/worker entry points and check whether each one receives an explicit tenant identifier or iterates tenants explicitly, versus relying on the same request-scoped context used by the web layer, which does not exist in a job runner. This is where tenant scoping is most often silently absent, because the code was written and tested only against the request path.
- [ ] Admin endpoints and internal tooling — `find_symbol` the admin route handlers and read whether tenant selection is an explicit parameter the operator supplies, or inherited from the same scoping code path used for a limited tenant-user, which may not generalise the way an admin tool needs it to.
- [ ] Data exports, report generation, and migrations — `find_callees` from each to confirm tenant filtering happens explicitly rather than being assumed from context that will not be present when the script runs standalone.
- [ ] Webhook and queue-consumer handlers that carry a tenant identifier in the payload — `find_symbol` the handler and confirm it re-derives the tenant from an authenticated/signed source (the subscription record, the API key that registered the webhook) rather than trusting a tenant ID the payload itself supplies, which a forged or misrouted event could set to any value. This is `High` at `read`; `trace_path` from the webhook/queue handler to the query function that consumes the tenant value, then `Read` the handler to confirm the payload's tenant field is what the traced path carries, promotes it to `traced`, and `Critical`. CWE-639 Authorization Bypass Through User-Controlled Key names exactly this failure mode; OWASP's Multi-Tenant Security Cheat Sheet: "treat client-supplied tenant identifiers as selectors only."

## Identifiers

- [ ] Sequential or otherwise guessable IDs (auto-increment integers) used as externally-exposed resource identifiers — `search_code` the API response shapes and URL path parameters for a numeric, sequential ID field. Combined with any authorisation gap, this permits enumeration across tenants even where scoping is otherwise correct, because the ID itself leaks the existence and ordering of other tenants' records. Cross-reference `abuse.md` for the enumeration/rate-limiting angle; report the identifier choice here. OWASP API1:2023 BOLA recommends "random and unpredictable values as GUIDs" instead; CWE-639 names sequential/guessable identifiers explicitly as the multi-tenant/horizontal-authorization failure mode.
- [ ] Whether a request for another tenant's real resource ID returns a distinguishable response (a 403/"forbidden" body) from the one used for a genuinely absent ID (404) in the same tenant-scoped query/repository layer — `search_code` the not-found and forbidden branches. A response an attacker can tell apart confirms the ID exists under a different tenant even when no data is returned. A shared error-handling layer that normalizes both branches to an identical response before they leave the service is not the finding — check that layer, not just the repository's own branch. Cross-reference `abuse.md` for the enumeration/rate-limiting half; report the response-shape choice here, same split as the check above. The existence signal is a lesser instance of the same user-controlled-key leak CWE-639 describes, on the same object-identifier attack surface as BOLA.

## Caches

- [ ] Every cache key touching tenant data includes the tenant identifier — `search_code` the cache-set/cache-get call sites for tenant-scoped data and read the key construction. A cache key built from a resource ID alone, with no tenant component, serves tenant A's cached value to tenant B's identical-shaped request. This is the highest-severity finding this module can produce, because it requires no attacker action at all — it fires on ordinary traffic the moment two tenants share a cache-key collision. PortSwigger's web cache deception documentation: a cache key that diverges from how the origin interprets the URL "lets a cache store and later replay one user's private, dynamic response to a different requester using the same key"; CWE-524 Use of Cache Containing Sensitive Information covers the same defect generally.
- [ ] Where the key does include a tenant component, check whether the cached value itself also carries the tenant identifier and is verified on read. `find_symbol` the cache-read path and confirm it checks the stored `tenant_id` against the expected one, rather than trusting key construction alone — a key-only guard has no second check if the key is ever built wrong at one call site while correct everywhere else. CWE-524: mitigations include verifying and protecting information stored in a shared cache, not trusting the key alone.

## Files and cross-boundary data

- [ ] Uploaded files and object-storage paths — `search_code` the upload handler's storage-path/key construction and check whether the tenant identifier is part of the path/prefix itself, or only enforced by an application-level check that a misconfigured bucket policy or a directly-guessed URL bypasses.
- [ ] Logs and error reports carrying tenant data — `search_code` the logger calls near tenant-data handling for full record dumps (rather than IDs) that could surface one tenant's data in another's support ticket or a shared observability tool. Cross-reference `privacy.md` for the general PII-in-logs concern; report the cross-tenant leak angle here.

## Cross-tenant features

- [ ] Sharing, transfer, or impersonation features (an admin "log in as" a tenant's user, moving a resource between tenants) — confirm each one is deliberately scoped and, ideally, audited (`search_code` for an audit-log write alongside the action), rather than being a side door that bypasses the scoping mechanism entirely because it was built as a special case.
- [ ] Test coverage for cross-tenant isolation — `search_code` the test suite for a case that asserts tenant A cannot read tenant B's data. Its absence is itself a finding: a scoping mechanism nobody has written a test to break is a mechanism nobody has verified.

## Out of static reach

- Whether a row-level security policy actually evaluates as expected against live data at runtime — the migration declaring `ENABLE`/`FORCE ROW LEVEL SECURITY` and the connection role's privileges are readable from source (see Query-level scoping above); whether the policy predicate itself is logically correct against real rows is not — closed by `runtime.md` when execution is enabled (running this module's own declared cross-tenant-isolation test).
- Real cache collision behaviour under production key distributions.
- Whether a background job's tenant loop actually covers every active tenant in practice.
- Storage bucket/IAM policy configuration outside the repository.
- Whether the reverse proxy or load balancer in front of this service already whitelists the Host header before the application ever sees it — this module reads application code, not infrastructure configuration.
- Whether tenant JWT signing keys are actually isolated per tenant in the secrets manager, versus one shared key read from the same config value this module can see — key material itself is out of static reach.
- Whether the batch tenant filter still applies under an adversarial or malformed ID-list payload — that is a `runtime.md`/fuzzing question, not a static read.
- Whether a search/vector store's underlying index or shard actually enforces the isolation its application-level query implies — cluster configuration is out of static reach.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number. Both rows need two authenticated tenant sessions the user provided credentials for, walked against the same endpoints; `network.jsonl` captures response bodies only on 4xx/5xx, so a 200 carrying the wrong tenant's data is **not** visible here — only status, size, headers and timing are diffed.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl` | Whether a tenant-scoped endpoint answers a second tenant's session with the first tenant's status, size or cache headers — a 200 with identical size where a 403/404 or a different payload size was expected, or a shared `ETag`/`Cache-Control` across tenants | High |
| `network.jsonl` | Whether a cached response actually crosses tenants on the flows walked — same `ETag`, same `Age`/`X-Cache` hit, same size for two tenant sessions requesting tenant-scoped data | High |
| `network.jsonl` (status **and** body, captured on 4xx/5xx) | Cross-tenant existence via a distinguishable error response — two authenticated tenant sessions, one requesting the other's real resource ID, compared against that same session requesting a genuinely absent ID, capped at or below the static `read`-tier finding since this only confirms the response is distinguishable, not that data was returned | Low |

## Severity guidance

| Situation | Severity |
|---|---|
| Raw SQL or bypassed repository layer with no tenant filter on a tenant-scoped table | Critical |
| Webhook/queue payload's self-declared tenant ID trusted without re-derivation (traced) | Critical |
| Cache key for tenant data with no tenant component | High |
| RLS enabled but not `FORCE`d, or app connects via a role with `BYPASSRLS`/superuser | High |
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
| Batch/bulk endpoint's query traced (`find_callees`) to skip the per-record tenant filter | High |
| Tenant resolved from Host header/subdomain with no registered-tenant-table lookup | High |
| JWT/session claim accepted with no tenant-membership check beyond signature validity | High |
| Non-relational/search store queried with no tenant filter and no per-tenant index/collection | High |
| Cross-tenant existence disclosed via a distinguishable error response (403 vs. 404) | Low |
