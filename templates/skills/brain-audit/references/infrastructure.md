# Infrastructure

Runtime environment and its definition. Gate: CI/CD, a Dockerfile, or IaC was detected.

`DevOps` audits how code becomes an artefact. This module audits where that artefact runs and whether the definition of that place is trustworthy.

## Declared vs. actual

- [ ] `search_code` for `.tf`, `Pulumi.*`, `*.bicep`, or a CloudFormation template, and cross-reference the resources they declare against the cloud SDK usage `get_architecture` reports for the application. A resource the app clearly talks to but no IaC declares is the candidate — **rule-out**: it may live in a separate, un-indexed infrastructure repo, so when no IaC directory exists in this repo at all, report the signal as `undetermined`, not as a confirmed hand-created resource.
- [ ] State is remote and locked, not local. `search_code` the Terraform `backend` block or the Pulumi state/backend config for a remote target (S3, GCS, Terraform Cloud) with locking (DynamoDB table, native lock) rather than a local `.tfstate`.
- [ ] Drift detection exists. `search_code` CI workflows for a scheduled `terraform plan` / `pulumi preview` job distinct from the apply-on-merge job, or a TACOS platform config that runs it for you — `atlantis.yaml`, a Spacelift/env0 stack definition, or an HCP Terraform workspace with drift detection enabled. A plan that only ever runs right before an apply never catches drift that accumulates between deploys.
- [ ] Every environment comes from the same definition with different inputs. Read the IaC directory structure: one module parameterised by `*.tfvars`/env-specific variables is the intended shape; separate copy-pasted per-environment directories (`envs/staging/main.tf`, `envs/prod/main.tf` diverging beyond their variables) is the finding — diff them.

## Configuration

- [ ] Every environment variable the application reads is declared in the deployment definition. Reuse `reachability.md`'s used-but-never-declared probe directly: `search_code` for `process.env.` / `os.environ` / the language's equivalent, then check each name against the deployment manifest's env list — this is where that check pays off most, because the failure mode is a variable that is `undefined` only in production.
- [ ] Required config with no value fails at startup, not at first use. `find_symbol` the config-loading module and read it: a schema-validated load that throws before the server binds its port is the standard; a lazy read that returns `undefined` and gets used three requests later is the finding.
- [ ] Defaults in the definition are safe for production. Read the deployment definition's default values for anything security-relevant — `debug: true`, a wildcard CORS origin, a verbose log level — a convenient development default is `High` if nothing overrides it in the production environment file.
- [ ] Nothing environment-specific is compiled into the artefact. `search_code` the build step for values injected at build time (webpack `DefinePlugin`, a baked-in API base URL, an embedded feature flag) rather than read at runtime — these force a rebuild per environment and silently defeat "one artefact, many environments".

## Resource limits

- [ ] CPU and memory limits are set. `search_code` Kubernetes manifests or compose files for `resources.limits` / `mem_limit`; absence is the finding — cross-reference `cost.md` where a limit is present but sits far above observed use.
- [ ] Disk is bounded and monitored wherever logs or uploads land. `search_code` volume mounts for a log or upload directory and check for a size cap or rotation config (`logrotate`, a max-size setting) alongside it.
- [ ] Connection and file-descriptor limits accommodate the configured pool sizes. Read the application's DB/connection pool size setting and compare it against the container's declared `ulimit` or fd limit where one is set — a pool ceiling above the fd ceiling only fails under load, never in development.
- [ ] Autoscaling bounds exist at both ends, and the scale-up signal is the resource that actually saturates. `search_code` the autoscaler config (HPA, ASG launch config) for `min`/`max` replicas and the triggering metric; cross-reference `performance.md` for whether that metric is the one that actually saturates first.

## Network and access

- [ ] Nothing is publicly reachable that does not need to be. `search_code` IaC or compose files for datastore ports (`5432:5432`, `6379:6379`, `27017:27017`) bound to a public interface rather than `127.0.0.1:` or a private subnet — a datastore port with no interface prefix in a compose file defaults to all interfaces. Rule out a compose file scoped to local development only (no corresponding production deploy target in the same file) before treating an open port binding as a production exposure.
- [ ] Ingress rules are specific rather than open ranges. `search_code` the IaC for `0.0.0.0/0`.
- [ ] Service-to-service access is least-privilege. Read the IAM role or policy document attached to each service in IaC — a wildcard `*` action or `*` resource on a role that only needs to read one bucket is the finding.
- [ ] Credentials are workload identities where available, rather than long-lived static keys. `search_code` the deployment definition for static key literals or key references (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) versus an instance-profile or workload-identity binding — presence of the former where the platform offers the latter is the finding.

## Durability

- [ ] Backups exist for every stateful resource the inventory names. `search_code` IaC or the managed-service config for a backup/snapshot-schedule attribute on each one — a resource with no such attribute has no backup, full stop. Rule out a managed offering whose provider enables automated backups by default outside any IaC-declared attribute; where the resource is a managed service with no attribute either way, report `undetermined` rather than a confirmed gap.
- [ ] Restore time and acceptable data loss are stated somewhere findable — a runbook, a README, an ADR. `search_code` the repo for a runbook, README, or ADR naming a restore-time objective or acceptable data loss. **Whether a restore has actually been performed and succeeded is not establishable from source**; report the runbook's existence (or absence) as the static half of this check and push the "actually tested" half to Out of static reach.
- [ ] Deletion protection on resources whose loss would be unrecoverable. `search_code` IaC for `deletion_protection` / `prevent_destroy` on the datastore and storage resources the inventory lists.
- [ ] Stateful data is not on ephemeral storage. Read the container or pod spec for the path the application writes state to — mounted on `emptyDir` or no volume at all is the finding; a persistent volume claim or managed volume is the pass.

## Operability

- [ ] Someone can reach logs, metrics, and a shell for a running instance without a bespoke procedure. Cross-reference `observability.md`; `search_code` for a centralised logging/metrics sink configured in the deployment definition versus container-stdout-only, which is unreachable once the container recycles.
- [ ] Restart, scale, and redeploy are single documented commands. Read the deployment docs or `Makefile`/scripts directory for these — their absence, when the app clearly does deploy somehow, is itself the finding: the knowledge exists only in one person's shell history.
- [ ] The definition names an owner. `search_code` IaC or manifest metadata (tags, labels, annotations) for an owner or team field — treat this as a soft signal: missing metadata implies but does not prove the resource is unowned, since ownership may be tracked outside the repo.

## Out of static reach

- Whether a backup restore actually succeeds — only executing one proves it; the runbook's existence is the ceiling of what source can show.
- Real autoscaling behaviour under load — the declared bounds and metric are checkable, whether they trigger correctly at the right threshold is not.
- Whether live cloud-console configuration matches declared IaC — drift detection can be configured and still be broken or unrun; the actual comparison happens outside this audit.
- Real network reachability from the public internet — a port scan or external probe would confirm it, IaC only states intent.
- Hand-created resources that exist entirely outside any indexed repo — invisible to `search_code` by definition; only a live account inventory would surface them.
- Actual on-call ownership and response readiness — an owner tag is a label, not a guarantee someone answers a page.

## Severity guidance

| Situation | Severity |
|---|---|
| Datastore or admin port publicly reachable | High |
| Long-lived static credentials in the definition | High |
| No backup for a stateful resource | High |
| No runbook or stated restore procedure found | Medium |
| Stateful data on ephemeral storage | High |
| Ingress open to `0.0.0.0/0` beyond a public entry point | High |
| Application env var not declared in the deployment | High |
| No resource limits set | Medium |
| Manually created resources absent from IaC | Medium |
| Local or unlocked state file | Medium |
| No drift detection | Low |
