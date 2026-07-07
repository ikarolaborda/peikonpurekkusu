# peikonpurekkusu — Implementation Plan

Companion to [architecture.md](architecture.md). Version pins verified 2026-07-06 via
Context7 + live registries (Context7 quota exhausted mid-sweep; remaining facts verified
against official registries/docs).

## 0. Cross-cutting decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Node Kafka client | `@confluentinc/kafka-javascript` 1.10.0 (+ `@confluentinc/schemaregistry` 1.10.0), NOT `@nestjs/microservices` Transport.KAFKA | kafkajs 2.2.4 unmaintained + known Kafka 4.x KRaft group-coordination bugs; broker is Kafka 4.3.1. OTel spans hand-rolled in our shared wrapper (no auto-instrumentation exists for the Confluent client). |
| NestJS ORM | MikroORM 7.1.5 (`@mikro-orm/postgresql`, `@mikro-orm/nestjs` 7.0.2, `@mikro-orm/migrations`) | First-party Nest module; Unit-of-Work makes outbox writes single-transaction trivial; `@Transactional()`; Kysely-backed SQL. Requires TS `module: nodenext`, Node ≥22.17. |
| Schema registry | Apicurio Registry 3.3.0 (`quay.io/apicurio/apicurio-registry:3.3.0`), ccompat endpoint `/apis/ccompat/v7`, JSON Schema, Confluent wire format | Apache-2.0 (no CCL conversation); serdes: franz-go `pkg/sr` v1.7.0 (Go, + santhosh-tekuri/jsonschema/v6 validation), `@confluentinc/schemaregistry` (Node), `Confluent.SchemaRegistry.Serdes.Json` 2.15.0 (.NET). Auto-register ON in dev. Source-of-truth schemas in `contracts/events/`. |
| Go migrations | goose v3.27.2 embedded (`embed.FS` + Provider API + Postgres session advisory locker), run at startup | Zero extra compose services; replica-safe via pg_advisory_lock. |
| .NET migrations | EF Core migration bundles (`dotnet ef migrations bundle --self-contained`), one-shot compose service + `service_completed_successfully` | Microsoft's production guidance; `Migrate()` at startup races with >1 replica. |
| Cassandra schema | One-shot cqlsh init job, idempotent DDL | No initdb.d equivalent in the cassandra image; DDL from exactly one process (schema agreement). |
| JWT verify (Go) | `golang-jwt/jwt` v5.3.1 + `MicahParks/keyfunc/v3` (JWKS auto-refresh) | Std API + background JWKS cache. Always `jwt.WithValidMethods`. |
| JWT verify (.NET) | `Microsoft.AspNetCore.Authentication.JwtBearer` 10.0.9 / `Microsoft.IdentityModel.*` 8.19.1 | ConfigurationManager auto-JWKS (12 h refresh + refresh-on-unknown-kid). |
| Signing alg | **ES256** everywhere | .NET has no native Ed25519; Azure Key Vault has no Ed25519. |
| DPoP | Documented as hardening path only | No production-grade Go validator exists; Duende (.NET) needs paid license. BFF cookies deliver the browser-side protection. |
| Redis clients | go-redis v9.21.0 · node-redis (`redis`) 6.1.0 (ioredis deprecated) · StackExchange.Redis 3.0.11 | All RESP3-default; server `redis:8.8-alpine`. |
| PostgreSQL | `postgres:18.4-alpine` | ⚠ PG18 image volume moved to `/var/lib/postgresql` (not `.../data`). `uuidv7()` native. |
| .NET mediator | Plain-DI `ICommandHandler<,>` (no MediatR — v13 is RPL/commercial) | Mediator pattern without the license. |
| Fraud engine | Plain Confluent.Kafka consumer + Redis sliding-window velocity counters (Lua: ZADD+ZREMRANGEBYSCORE+ZCARD) + chain-of-responsibility `IFraudRule` pipeline + optional ML.NET 5.0 `PredictionEnginePool` hook | Microsoft RulesEngine frozen since 2024 + injection-prone; Streamiz = bus-factor-1. NRules 1.0.4 only if rules outgrow ~30. |
| Outbox relay | Polling (`FOR UPDATE SKIP LOCKED`, partial index on unprocessed, batch, ORDER BY uuidv7 id) | Right for this scale; table schema kept Debezium-3.6-compatible (id/aggregatetype/aggregateid/type/payload) so CDC swaps in with zero app changes. |

## 1. Repository layout

```
peikonpurekkusu/
├── Makefile                     # make up|down|reset|logs|smoke|seed
├── docker-compose.yml           # full stack (profiles: default, ha, observability)
├── .env.example                 # all config; make up copies to .env + generates secrets/
├── contracts/
│   ├── proto/                   # account.proto, fraud.proto (buf-generated stubs per lang)
│   ├── events/                  # JSON Schema per event type (source of truth, registered to Apicurio)
│   └── openapi/                 # gateway-facing API spec
├── infra/
│   ├── kafka/create-topics.sh
│   ├── cassandra/init.cql
│   ├── postgres/                # (only shared bits; schemas live with services)
│   ├── traefik/dynamic.yml      # tls options, shared middlewares
│   ├── observability/otel-collector.yaml
│   └── azure/                   # Bicep + azure.yaml (azd)
├── services/
│   ├── user-service/            # NestJS 11 — auth, JWKS, sessions, ForwardAuth /verify
│   ├── account-service/         # Go — ledger, holds, balances (gRPC + REST reads)
│   ├── payment-service/         # Go — saga orchestrator, idempotency, PSP adapters
│   ├── transaction-service/     # .NET 10 — immutable recording + queries
│   ├── fraud-service/           # .NET 10 — inline Score gRPC + async deep analysis
│   ├── notification-service/    # NestJS 11 — channels, SSE hub
│   ├── audit-service/           # Go — Kafka firehose → Cassandra/PG sink
│   └── mock-psp/                # Go — configurable external gateway simulator
├── frontend/                    # Angular 22 + Tailwind 4.3 (peikon identity)
└── scripts/                     # gen-keys.sh, seed.sh, smoke.sh, register-schemas.sh
```

## 2. Service blueprints

### user-service (NestJS 11.1 · Node 24 · pnpm 11)
- **Modules:** `auth` (login/refresh/logout/verify), `users` (register/KYC/profile), `mfa`
  (strategy: TOTP + mock SMS/email), `sessions`, `keys` (ES256 keypair mgmt, JWKS, kid
  rotation), `outbox`.
- **Flow details:** Argon2id (`argon2` 0.44 defaults); access JWT 10 min (`jti`, ES256 via
  `jose` 6.2.3); refresh = opaque 256-bit random, SHA-256 hash stored in
  `refresh_tokens(family_id, generation, expires_at, consumed_at, revoked_at)`;
  rotation consumes atomically (single UPDATE … WHERE consumed_at IS NULL), reuse →
  family revocation + `identity.user.session_revoked.v1` + denylist fan-out; sessions
  in redis-session (`session:<id>` hash + `user:<id>:sessions` set), device-fingerprint
  hash + coarse IP; `/verify` endpoint for Traefik ForwardAuth: parse cookie → verify
  ES256 + claims → check `revoked:jti:*` + session binding → 200 with `X-User-Id`,
  `X-User-Roles` or 401. CSRF: double-submit cookie, enforced on mutating routes.
- **Patterns:** Facade (`AuthFacade`), Strategy (MFA channels), Factory (token/key),
  Guard chain (CoR).
- **DB:** users, refresh_tokens, outbox (MikroORM entities + migrations).

### account-service (Go 1.26 · pgx 5.10 · sqlc 1.31 · goose)
- **Packages:** `internal/ledger` (postings, invariants), `internal/holds`,
  `internal/balances`, `internal/grpc` (Hold/Capture/Release/GetBalance, deadline-aware),
  `internal/httpapi` (REST reads: accounts, balances, entries), `internal/outbox`,
  `internal/cache` (display-only read-through, delete-on-write).
- **Rules:** serializable posting tx (retry on 40001); SUM(debits)=SUM(credits) enforced;
  `account_balances.version` optimistic; holds sweeper releases expired (7-day default);
  reconciliation command re-derives balances.
- **Patterns:** Facade (`LedgerFacade`), Repository, Factory (posting builders),
  Strategy (balance read: cached vs authoritative).

### payment-service (Go 1.26)
- **Packages:** `internal/saga` (state machine + persisted saga state + compensations),
  `internal/idempotency` (Stripe-style records incl. request hash + response snapshot +
  recovery points), `internal/psp` (port `PaymentProcessor`; adapters: `mockpay`
  card-style, `mockwallet` PayPal-style; factory by payment method; gobreaker circuit
  breaker + backoff/jitter retries), `internal/fraudclient` (gRPC, 150 ms deadline,
  amount-tiered timeout policy — Strategy), `internal/accountclient` (gRPC),
  `internal/fx` (append-only rates, quote capture), `internal/httpapi` (POST /payments
  requires Idempotency-Key; GET /payments/:id; SSE /payments/:id/events), `internal/outbox`.
- **DB:** payments (PaymentIntent-style status), payment_instruments (token/brand/last4
  only), merchants, exchange_rates, fx_quotes, idempotency_keys, saga_state, outbox,
  processed_events.

### transaction-service (.NET 10 · EF Core 10 · Npgsql 10.0.2)
- Minimal APIs (`AddValidation()` — mandatory), route groups per aggregate; plain-DI
  mediator (`ICommandHandler<,>`); BackgroundService Kafka consumer
  (`EnableAutoOffsetStore=false`, store offset only after durable write); idempotent
  consumer (processed_events table, same tx); immutable `transactions` +
  `transaction_corrections` as reversing rows; outbox + relay HostedService;
  EF bundle migrator container.

### fraud-service (.NET 10)
- gRPC `Score` (Grpc.AspNetCore): CoR pipeline — velocity (Redis exact sliding window
  via Lua), amount-tier, geo/device anomaly, denylist, optional ML.NET scorer
  (`PredictionEnginePool`, model.zip hot-reload); 20 ms Redis budget, fail-open +
  flag-for-review on cache timeout (policy per amount tier — Strategy).
- Async: BackgroundService consumer over `payments.*` doing deep analysis
  (impossible-travel, cross-account patterns) → `fraud.score.flagged.v1` → may trigger
  reversal saga / step-up.
- **DB:** fraud_rules config, fraud_logs (model_version, features_snapshot JSONB, decision).

### notification-service (NestJS 11.1)
- Kafka consumers → templating (template_id + params; no raw PII in payloads) →
  channel strategies (email/SMS/push mock transports logging to a dev inbox table) →
  delivery_attempts with retry/backoff; SSE hub pushing payment status to the SPA
  (auth via ForwardAuth headers). MikroORM; outbox for `notifications.*` facts.

### audit-service (Go 1.26)
- franz-go consumer group over `*.v1`; envelope → `audit.events` Cassandra table
  ((tenant, day) partitions, timeuuid clustering, TWCS 1-day windows, table TTL,
  LOCAL_QUORUM, idempotent client timeuuid); `AUDIT_SINK=cassandra|postgres` behind a
  sink Adapter; driver `apache/cassandra-gocql-driver/v2` 2.1.2.

### mock-psp (Go 1.26)
- `/authorize`, `/capture/:ref`, `/reverse/:ref` + async webhook mode → publishes
  `gateway.psp.completed.v1` (simulating the Gateway Response Queue); env-tunable
  latency/failure/decline; idempotent by our payment reference.

### frontend (Angular 22.0 · Tailwind 4.3.2)
- Zoneless, standalone, signals; Signal Forms for checkout; `httpResource` for reads;
  NgRx SignalStore for session/payment-flow state; SSE for live payment status
  (processing → succeeded, Stripe-style).
- **Views:** auth (login/register/MFA step-up), dashboard (accounts + balances),
  send-payment wizard (amount+currency → FX quote display → instrument → review →
  processing/receipt), transactions list + receipt detail, notifications center,
  security center (active sessions, revoke-all — shows off the JWT hardening).
- **Identity ("peikon" visual language):** Tailwind 4 CSS-first `@theme` —
  `--radius-*: 0px` (square borders; `rounded-full` overridden via `@utility`),
  oklch palette: ink `#0A0A0F`-ish dark base, electric magenta/pink accent (nod to the
  original diagrams) + acid green success + signal red danger; JetBrains Mono numerals
  for amounts; 1px hard borders, no shadows (flat, terminal-adjacent aesthetic);
  dark mode default with `@custom-variant` class toggle.
- nginx-unprivileged, `dist/<project>/browser`, SPA fallback, CSP/security headers.

## 3. Delivery phases

1. **Contracts + infra** (tasks #4, #5): compose infra profile, topics, keyspace,
   Apicurio, protos, event schemas, Makefile, key generation.
2. **Vertical slice 1 — identity:** user-service + Traefik ForwardAuth + frontend auth
   screens. Login end-to-end through the gateway.
3. **Vertical slice 2 — money path:** account-service + payment-service + mock-psp +
   fraud-service inline Score. POST /payments end-to-end (hold → PSP → capture).
4. **Vertical slice 3 — facts fan-out:** transaction-service, notification-service,
   audit-service, deep fraud analysis, SSE to frontend.
5. **Frontend completion + identity polish.**
6. **One-command setup + seeds + smoke** (task #13), then Azure artifacts (#14),
   then full-stack verification + adversarial review workflow (#15).

Services in phases 3–4 are implemented by parallel agents (disjoint directories) against
the frozen contracts from phase 1.

## 4. Definition of done (per service)

Multistage Dockerfile (pinned base images, non-root, BuildKit cache mounts); health
live/ready split; OTel traces + metrics + JSON logs with traceparent propagation
(manual spans around Kafka in Node); unit tests for money/auth invariants
(ledger balance-sum property test, idempotency replay test, refresh-reuse detection
test, fraud rule pipeline test); consumer idempotency + DLQ wiring; README per service.
