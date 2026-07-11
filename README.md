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
| `frontend` | Angular 22 + Tailwind 4 | Token-free httpOnly-cookie auth, live payment status over SSE |

## Repositories (multi-repo layout)

This is the **aggregator repository**: it owns the Docker topology, infrastructure
config, scripts and documentation, and mounts every deliverable as a **git submodule**.

| Path | Repository | Stack |
| --- | --- | --- |
| `services/user-service` | [peikonpurekkusu-user-service](https://github.com/ikarolaborda/peikonpurekkusu-user-service) | NestJS 11 — identity, JWT/JWKS, sessions |
| `services/account-service` | [peikonpurekkusu-account-service](https://github.com/ikarolaborda/peikonpurekkusu-account-service) | Go 1.26 — double-entry ledger, holds |
| `services/payment-service` | [peikonpurekkusu-payment-service](https://github.com/ikarolaborda/peikonpurekkusu-payment-service) | Go 1.26 — payment saga, idempotency, PSPs |
| `services/transaction-service` | [peikonpurekkusu-transaction-service](https://github.com/ikarolaborda/peikonpurekkusu-transaction-service) | .NET 10 — immutable transaction record |
| `services/fraud-service` | [peikonpurekkusu-fraud-service](https://github.com/ikarolaborda/peikonpurekkusu-fraud-service) | .NET 10 — inline gRPC scoring, deep analysis |
| `services/notification-service` | [peikonpurekkusu-notification-service](https://github.com/ikarolaborda/peikonpurekkusu-notification-service) | NestJS 11 — templated fan-out, SSE |
| `services/audit-service` | [peikonpurekkusu-audit-service](https://github.com/ikarolaborda/peikonpurekkusu-audit-service) | Go 1.26 — event firehose → append-only log |
| `services/mock-psp` | [peikonpurekkusu-mock-psp](https://github.com/ikarolaborda/peikonpurekkusu-mock-psp) | Go 1.26 — deterministic external gateway |
| `frontend` | [peikonpurekkusu-frontend](https://github.com/ikarolaborda/peikonpurekkusu-frontend) | Angular 22 + Tailwind 4 |
| `contracts` | [peikonpurekkusu-contracts](https://github.com/ikarolaborda/peikonpurekkusu-contracts) | Event schemas, protobufs, generated stubs |

Clone with submodules and always build/run from here — the Docker build contexts
and the `contracts/gen` path dependencies (Go `replace`, C# `Compile Include`)
resolve against this repo's root:

```bash
git clone --recurse-submodules https://github.com/ikarolaborda/peikonpurekkusu.git
# or, after a plain clone:
git submodule update --init --recursive
```

## Architecture

- [docs/architecture.md](docs/architecture.md) — target architecture
- [docs/architecture-review.md](docs/architecture-review.md) — review of the original design
- [docs/architecture-audit.md](docs/architecture-audit.md) — adversarial sweep of the *implementation*: what was fixed, and the ranked backlog of what is knowingly still open
- [docs/review.md](docs/review.md) — full-stack verification record