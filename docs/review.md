# Verification & review record

## Full-stack verification (live)

Brought the entire stack up (`22/22` containers healthy simultaneously) and ran
the end-to-end smoke suite — **18/18 checks GREEN, exit 0** — plus `make seed`.

| Slice | What it proves against the running system |
|---|---|
| auth | register → login (httpOnly cookies + CSRF) → gateway ForwardAuth identity → CSRF enforced on mutations → refresh rotation → **refresh-reuse detection revokes the whole family** → revoked session's tokens dead everywhere → JWKS published |
| account | registration event → account auto-provisioned via Kafka → $1,000 welcome deposit posted **double-entry** (source=ledger) → immutable entries readable |
| payment | card saga fraud→hold→PSP→capture → **succeeded**; idempotency replay returns the same payment (no double charge); gateway decline → failed **+ hold released**; wallet async completion via Kafka; **ledger exact to the cent** across a success+decline+async mix (95450/0); captured→recorded transaction fan-out into the .NET service |
| notification | 74 notifications rendered across welcome/payment_captured/payment_failed + mock channel deliveries |
| audit | full 18-topic firehose → append-only partitioned log |

A gRPC probe additionally exercised the account ledger directly: hold →
idempotent replay (same hold, no double reservation) → partial capture with
remainder release → double-capture rejected → exact final balance.

## Adversarial review — findings fixed during bring-up

Real defects found by running the system and fixed (not just theorized):

1. **Silent event loss on DLQ-publish failure** (.NET consumers) — a failed DLQ
   write still advanced the offset. Now the offset is left uncommitted so the
   message reprocesses.
2. **Idempotency gate always skipped** (notification-service) — MikroORM's
   `execute()` doesn't populate `affectedRows` for `INSERT..ON CONFLICT`; the
   gate read 0 and dropped every event. Fixed with `RETURNING` + row count.
3. **Wedged outbox relay after broker restart** (user-service) — the librdkafka
   producer couldn't re-acquire its idempotent PID; added a send-timeout +
   producer self-heal.
4. **Cross-stack Traefik collision** — another local stack's generic `frontend`
   router hijacked ours. Namespaced all routers/services + constrained the
   docker provider to `peikon.stack=true` containers.
5. **`processed_at` NOT NULL without default**, **PG18 volume-path change**,
   **Apicurio h2/postgresql datasource activation**, **ES256 PKCS#8 key
   format** — all found and fixed live.

## Money-correctness audit (static re-read)

- **No floating point on any monetary value.** All amounts are integer minor
  units; every money column is `bigint`/`long` with `CHECK (>= 0)` or `(> 0)`.
  The frontend `/10^exponent` is display formatting only (ISO-4217 aware, JPY
  never divided — unit-tested).
- **Double-entry invariant enforced** in code (`ValidateBalanced`,
  property-tested) *and* by DB triggers making ledger rows immutable.
- **Balance mutations are serializable-transaction-safe**: holds lock the
  balance row; captures rely on `pgx.Serializable` + retry on 40001 — concurrent
  operations on one account serialize correctly.
- **All SQL is parameterized** (`$N` / `?`); no string-built queries.
- **Idempotency everywhere money moves**: gRPC request-id replay records,
  unique ledger idempotency keys, Stripe-style payment idempotency records,
  and idempotent Kafka consumers (`processed_events` in the same tx).
- **Compensation is belt-and-braces**: saga failure releases the hold via gRPC
  *and* emits `payment.failed`, which account-service also consumes to release
  orphaned holds.

## Known limitations (honest)

- The 8 GB dev VM runs all 22 containers only with per-service memory caps; a
  cold `make up` needs a warm Kafka before a single clean smoke pass (group
  coordinator is latency-sensitive under load). Idle footprint ≈ 1.3 GB.
- Mock PSP; not PCI-certified; card data never enters the system (token-only).
- Azure Bicep compiles clean but has not been applied to a live subscription
  from this environment.
- `.NET`/Go schema management uses `EnsureCreated`/`goose` at boot for the
  single-replica dev compose; production path is migration bundles (documented).
