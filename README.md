# peikonpurekkusu (ペイコンプレックス)

High-availability payments platform — polyglot microservices behind Traefik, with a
Kafka event backbone, per-service PostgreSQL, Redis, Cassandra audit logs, and an
Angular frontend.

> ⚠️ Demo/reference system. Uses mock external payment processors; not PCI-certified.

## One-command setup

```bash
make up
```

Builds every image, starts infrastructure with health-gated ordering, runs migrations,
creates Kafka topics and the Cassandra keyspace, seeds demo data, and prints the URLs.

Other targets: `make down` · `make reset` · `make logs` · `make smoke`.

## Services

| Service | Tech | Responsibility |
|---|---|---|
| `user-service` | NestJS | Identity, Argon2id credentials, JWT (ES256+JWKS), refresh rotation, sessions, ForwardAuth |
| `account-service` | Go | Double-entry ledger, balances, funds holds (gRPC) |
| `payment-service` | Go | Payment saga orchestrator, idempotency, external gateway adapters |
| `transaction-service` | .NET | Immutable transaction recording & queries |
| `fraud-service` | .NET | Inline pre-auth scoring (gRPC) + async deep analysis |
| `notification-service` | NestJS | Templated email/SMS/push (mock transports), SSE status push |
| `audit-service` | Go | Domain-event firehose → Cassandra audit log |
| `frontend` | Angular + Tailwind 4 | Stripe/PayPal-grade payment UX |

## Documentation

- [docs/architecture-review.md](docs/architecture-review.md) — review of the original design, with corrections
- [docs/architecture.md](docs/architecture.md) — target architecture
- [docs/plan.md](docs/plan.md) — implementation plan
- [docs/azure.md](docs/azure.md) — Azure deployment path
