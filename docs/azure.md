# Azure deployment

The stack was built 12-factor from day one so the cloud lift is a config change,
not a rewrite: every backing address is an env var, every service logs to
stdout, has split liveness/readiness probes, one ingress port, and is memory-
capped. This is what makes the compose → Azure mapping mechanical.

## Target topology (Azure Container Apps)

| Compose | Azure | Why |
|---|---|---|
| Traefik | Container Apps ingress + a gateway app | ACA gives TLS, routing, scale; ForwardAuth stays as the user-service `/auth/verify` app |
| 9 service containers | Azure Container Apps | KEDA autoscale (HTTP + Event Hubs lag); `minReplicas: 1` on hot paths to avoid cold-start latency on the money path |
| Kafka (KRaft) | Event Hubs, Kafka endpoint (`:9093`, SASL_SSL) | managed; clients keep `KAFKA_BOOTSTRAP_SERVERS`, gain `security.protocol=SASL_SSL` + OAUTHBEARER via managed identity |
| 8× PostgreSQL | PostgreSQL Flexible Server (PG18), DB per service | zone-redundant HA + PITR for production; Entra ID auth = passwordless from managed identity |
| 2× Redis | Azure Managed Redis (Balanced B0) | Azure Cache for Redis is retiring; app separates session/cache by key prefix |
| Apicurio | Container App (SQL storage → the same PG server) | no managed schema-registry equivalent |
| Cassandra (opt) | Azure Managed Instance for Apache Cassandra | only if `AUDIT_SINK=cassandra`; else the audit-db Flexible Server covers it |
| secrets in `.env` | Key Vault + per-service user-assigned managed identity (`Key Vault Secrets User`) | nothing secret in images or env at rest |
| images | Azure Container Registry (Standard) | pull via `AcrPull` managed identity, no admin creds |

## Deploy

```bash
cd infra/azure
azd auth login
azd env new peikon-prod
azd env set POSTGRES_ADMIN_PASSWORD "<strong-secret>"   # or wire a pipeline secret
azd up                                                   # provisions Bicep + builds/pushes/deploys every service
```

`azd up` runs `main.bicep` (resource group, ACR, Container Apps env, Key Vault,
Event Hubs + all topics, PostgreSQL + all databases, Managed Redis) then builds
each image from `azure.yaml` and deploys it to the environment.

## What changes per environment (env vars only)

- `KAFKA_BOOTSTRAP_SERVERS` → `<ns>.servicebus.windows.net:9093`; add
  `KAFKA_SECURITY_PROTOCOL=SASL_SSL`, `KAFKA_SASL_MECHANISM=OAUTHBEARER`
  (managed identity) — the Go/Node/.NET clients all support this; wire it in
  each service's platform config (the connection code is already isolated).
- `*_DB_HOST` → the Flexible Server FQDN; enable Entra ID auth for passwordless.
- `REDIS_*_HOST` → the Managed Redis host with TLS + cluster-aware client
  config (go-redis/node-redis/StackExchange.Redis are all cluster-capable).
- `SCHEMA_REGISTRY_URL` → the Apicurio Container App internal URL.
- Frontend `connect-src` CSP + `__PEIKON_API__` → the public gateway hostname.

## Production hardening checklist (beyond this skeleton)

- Flexible Server + Managed Environment: flip `highAvailability`/`zoneRedundant` on.
- Event Hubs: Premium/Dedicated if you need Kafka transactions or >7-day retention.
- Cookie policy: `COOKIE_SECURE=true` with `__Host-at`/`__Secure-rt` names (TLS everywhere).
- JWT signing key in Key Vault (ES256 — Azure Key Vault has no Ed25519, which
  is exactly why the platform standardized on ES256).
- Per-service user-assigned identities with least-privilege RBAC; ACR ABAC to
  scope each CI push to its own repo.
- Set `minReplicas: 1` on user/account/payment/fraud (latency-sensitive);
  scale-to-zero is fine for audit/notification.

## Notes / limitations

This is a deployable **skeleton**: the platform Bicep provisions and is
`az bicep build`-clean; the per-app Container App resources are materialized by
`azd deploy` from `azure.yaml`. It has not been applied against a live
subscription from this environment (no Azure credentials here) — treat the
first `azd up` as a staging exercise and expect to tune SKUs to your quota.
