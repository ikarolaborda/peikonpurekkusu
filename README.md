# peikonpurekkusu (ペイコンプレックス)

High-availability payments platform — polyglot microservices behind Traefik, with a
Kafka event backbone, per-service PostgreSQL, dual Redis, an Apicurio schema
registry, and an Angular frontend with its own visual identity.

> ⚠️ Demo/reference system. Uses mock external payment processors; not PCI-certified.

## One-command setup

```bash
make up          # builds every image, starts ~22 containers with health-gated ordering
make seed        # demo users (alice/bob/carol@peikon.dev) with balances + payment history
make smoke       # 18-check end-to-end suite: auth, ledger, payment saga, transactions
```

Then open **http://app.localhost:9080** (Traefik binds `HTTP_PORT`, default 9080 —
change it in `.env` if taken). Demo password: `peikon-demo-passw0rd!`.
Traefik dashboard: http://traefik.localhost:9080 (admin / peikon-dev).

**Requirements:** Docker with **≥ 6 GB free** in its VM (every container is
memory-capped; the stack idles ≈ 1.3 GB but caps total ≈ 5 GB), plus ports
9080 free. Other targets: `make down` · `make reset` (wipes volumes) · `make logs`.

## Services

| Service | Tech | Responsibility |
|---|---|---|
| `user-service` | NestJS 11 | Identity, Argon2id, ES256 JWT + JWKS, rotating refresh tokens with reuse detection, sessions/denylist in Redis, Traefik ForwardAuth |
| `account-service` | Go 1.26 | Append-only double-entry ledger, materialized balances, two-phase holds (gRPC), reconciliation |
| `payment-service` | Go 1.26 | Orchestrated payment saga, Stripe-style idempotency, PSP adapters + circuit breaker, FX quotes, SSE status |
| `mock-psp` | Go 1.26 | Deterministic external gateway (…42 declines, …13 transient errors, async wallet flow) |
| `transaction-service` | .NET 10 | Immutable transaction recording (DB-enforced) + history queries |
| `fraud-service` | .NET 10 | Inline gRPC scoring (CoR rule pipeline, Redis velocity windows) + async deep analysis |
| `notification-service` | NestJS 11 | Event→template fan-out, channel strategies (mock email/SMS/push + in-app), SSE live feed |
| `audit-service` | Go 1.26 | Full event firehose → append-only audit (PostgreSQL partitioned; Cassandra behind `COMPOSE_PROFILES=cassandra`) |
| `frontend` | Angular 22 + Tailwind 4 | St