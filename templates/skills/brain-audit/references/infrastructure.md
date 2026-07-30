# Infrastructure

Runtime environment and its definition. Gate: CI/CD, a Dockerfile, or IaC was detected.

`DevOps` audits how code becomes an artefact. This module audits where that artefact runs and whether the definition of that place is trustworthy.

## Declared vs. actual

- [ ] Infrastructure is in code. Resources created by hand are undocumented, unreviewable, and unreproducible — that gap is the first finding.
- [ ] State files are remote and locked, not local. A local state file means one machine holds the only truth.
- [ ] Drift is detectable — something compares declared to actual. Without it, IaC describes intentions rather than reality.
- [ ] Every environment comes from the same definition with different inputs. Divergent per-environment definitions guarantee "works in staging".

## Configuration

- [ ] Every environment variable the application reads is declared in the deployment definition. Cross-reference the used-but-never-declared sweep in `reachability.md` — this is where that check pays off most.
- [ ] Required config with no value fails at startup, not at first use in production.
- [ ] Defaults in the definition are safe for production, not convenient for development.
- [ ] Nothing environment-specific is compiled into the artefact.

## Resource limits

- [ ] CPU and memory limits are set. No limit means one process can starve its neighbours; a limit far above observed use wastes money — cross-reference `cost.md`.
- [ ] Disk is bounded and monitored, especially wherever logs or uploads land.
- [ ] Connection and file-descriptor limits accommodate the configured pool sizes. A pool larger than the descriptor limit fails under load only.
- [ ] Autoscaling bounds exist at both ends, and the scale-up signal is the resource that actually saturates.

## Network and access

- [ ] Nothing is publicly reachable that does not need to be — databases, caches, admin ports, metrics endpoints.
- [ ] Ingress rules are specific rather than open ranges. `search_code` the IaC for `0.0.0.0/0`.
- [ ] Service-to-service access is least-privilege, not a shared broad role.
- [ ] Credentials are workload identities where available, rather than long-lived static keys.

## Durability

- [ ] Backups exist for every stateful resource, and a restore has been performed. An untested backup is not a backup.
- [ ] Restore time and acceptable data loss are stated, not assumed.
- [ ] Deletion protection on resources whose loss would be unrecoverable.
- [ ] Stateful data is not on ephemeral storage.

## Operability

- [ ] Someone can reach logs, metrics, and a shell for a running instance without a bespoke procedure. Cross-reference `observability.md`.
- [ ] Restart, scale, and redeploy are single documented commands.
- [ ] The definition names an owner. Unowned infrastructure is what still runs three years after the team forgot it.

## Severity guidance

| Situation | Severity |
|---|---|
| Datastore or admin port publicly reachable | Critical |
| Long-lived static credentials in the definition | Critical |
| No backup for a stateful resource | High |
| Backup exists but restore never tested | High |
| Stateful data on ephemeral storage | High |
| Ingress open to `0.0.0.0/0` beyond a public entry point | High |
| Application env var not declared in the deployment | High |
| No resource limits set | Medium |
| Manually created resources absent from IaC | Medium |
| Local or unlocked state file | Medium |
| No drift detection | Low |
