# peikonpurekkusu — Architecture Review

Review of the envisioned architecture (diagrams + narrated flows) before implementation.
Verdict format: **KEEP** (sound as-is), **FIX** (correct defect), **ADD** (missing piece).

---

## 1. What is sound and stays

- **KEEP — Database per service.** User/Account/Payment/Transaction on PostgreSQL, each with its own schema and no cross-service DB access.
- **KEEP — Kafka as the event backbone** for facts that already happened (transaction recorded, notification requested, fraud event emitted).
- **KEEP — Idempotency keys** on payment processing (narrated correctly: checked before commit).
- **KEEP — Retry + exponential backoff + circuit breaker** on the external gateway integration.
- **KEEP — Saga with compensating actions** for the distributed payment flow.
- **KEEP — Async fraud scoring, notifications off the critical path.**
- **KEEP — Redis for session-related lookups and read caching** (with corrected semantics, see §3).
- **KEEP — Load-balanced API gateway** in front of everything (we implement with Traefik).

---

## 2. Critical money-correctness issues

### 2.1 FIX — Mutable `balance` column is not an acceptable source of truth
The Accounts table stores `balance` / `locked_balance` as mutable columns that get
overwritten. Payments systems use a **double-entry ledger**: an append-only
`ledger_entries` table where every movement is two entries (debit one account, credit
another) that must sum to zero per transaction. The account balance is **derived**
(SUM over entries) and materialized into `account_balances` **in the same DB
transaction** as the entry insert, guarded by optimistic concurrency (`version`
column) plus a `CHECK (available >= 0)` constraint.

Why: an overwritten column has no audit trail, cannot be reconciled, and makes
concurrent-update bugs (lost updates, double-spends) invisible. The ledger makes every
cent traceable and reconciliation a query, not an incident.

### 2.2 FIX — "Locks the required amount in Redis" — never
The narration has the Payment Service locking funds in Redis when the cached balance
is sufficient. **Funds holds must only ever exist in PostgreSQL**, as ledger rows
(`holds` table: hold_id, account_id, amount, status=active/captured/released,
expires_at) written inside a serializable/`SELECT ... FOR UPDATE` transaction in the
Account Service. Redis is a read-through cache for display purposes only.

Why: Redis is best-effort (eviction, restart, replication lag). A "lock" that can
evaporate means double-spending real money. Equally: **an authorization decision must
never be made from a cached balance** — cache for reads, DB for decisions.

### 2.3 FIX — Amounts as decimal floats, JPY with 2 decimals
Sample data shows `50000.00 JPY` and `amount 200.00`. Store money as **integer minor
units** (`BIGINT`, e.g. cents) + ISO-4217 `currency_code`, with a currency-exponent
table (JPY = 0 decimals, BHD = 3). All arithmetic in integers; format at the edge.
`NUMERIC(19,4)` is the fallback where integers are impractical — never
float/double anywhere.

### 2.4 FIX — Exchange-rates table is inconsistent and mutable
`USD→EUR 0.92` and `EUR→USD 1.09` are mutually inconsistent (1/0.92 ≈ 1.087), and
`last_updated` implies rows are overwritten. Corrections:
- **Append-only** rate table: (base, quote, rate, source, valid_from). History is the point.
- Store one direction per pair per source; derive the inverse — never store both independently.
- **Capture the rate on the payment record** (`fx_rate_used`, `rate_id`) at quote time.
  A payment quoted at one rate must not settle at another.

### 2.5 ADD — No idempotency-key column anywhere
The narration requires idempotency, but no table has the key. The Payments table gets
`idempotency_key` (unique per user), plus a Stripe-style `idempotency_records` table:
(key, request_hash, response_snapshot, status, expires_at). Same key + same payload →
replay stored response; same key + different payload → 409/422.

### 2.6 ADD — Transactional outbox
Every narrated step is "commit to DB, then publish to Kafka" — a dual write. If the
process dies between the two, state and events diverge (payment recorded, account
never debited). Every service that emits events gets an **outbox table** written in
the same DB transaction as the state change, with a relay (polling publisher or
Debezium CDC) that publishes to Kafka. Consumers are idempotent (processed-message
table keyed by message id/idempotency key), because delivery is at-least-once.

---

## 3. JWT theft protection (the explicit requirement)

The current design: long-ish-lived JWT returned to the client, stored raw in the
session document, verified at the gateway. Weaknesses: a stolen token is usable until
expiry, from anywhere, and cannot be revoked; the raw JWT sits server-side in
Cassandra; localStorage-style storage in a SPA is XSS-harvestable.

The hardened design we implement:

| Measure | Detail |
|---|---|
| Short-lived access tokens | 5–10 min TTL. Blast radius of theft is minutes, not hours. |
| Refresh-token rotation + reuse detection | Refresh token is one-shot; each refresh issues a new pair and invalidates the old. A **reused** (already-rotated) refresh token = theft signal → revoke the entire session family, force re-auth, emit security event. |
| httpOnly cookies via BFF stance | Browser never sees tokens from JS: access + refresh tokens live in `httpOnly; Secure; SameSite=Strict` cookies scoped to the API origin; Angular gets CSRF protection via double-submit token. No localStorage, ever. |
| Asymmetric signing + JWKS | ES256/EdDSA. User Service holds the private key; gateway and services verify against a published JWKS endpoint with `kid`-based rotation. No shared HMAC secret smeared across services. |
| `jti` + Redis denylist | Every access token carries `jti`; logout/compromise puts the `jti` (or the session id for family-wide kill) in Redis with TTL = remaining token life. Gateway ForwardAuth checks it — this is what makes "revoke now" real despite stateless JWTs. |
| Session binding | Session record (Redis) stores device fingerprint hash + coarse IP; refresh from a materially different context → step-up (MFA) instead of silent refresh. |
| Never store raw JWTs server-side | Session store keeps `jti`/token **hashes** only (the Cassandra session doc in the diagram stores the full JWT — fix). |
| Strict claims | `iss`, `aud` per service, `exp`, `nbf`, tight clock skew, algorithm pinned server-side (no `alg: none` / RS-HS confusion). |
| Step-up MFA | High-risk operations (new payee, large amount, fraud-flagged) require a fresh `amr`/`auth_time` claim — an old-but-valid token is not enough to move money. |

DPoP (RFC 9449, sender-constrained tokens) is noted as a v2 hardening option; the
BFF-cookie stance gives most of the benefit for a browser client without the key-management cost.

---

## 4. Flow & messaging corrections

### 4.1 FIX — Request/response Kafka queues on the synchronous critical path
The design pairs `Balance Check Queue`/`Balance Response Queue` (and gateway
request/response queues) to do **synchronous request-reply over Kafka** while the user
waits. That buys the worst of both worlds: consumer-group rebalances, per-message
latency, correlation bookkeeping, and no backpressure semantics for a caller that
blocks anyway.

Correction — split by intent:
- **Synchronous, user-waiting steps** (authorize + hold funds): Payment Service →
  Account Service over **gRPC** with deadlines, retries, and circuit breaker. The hold
  is a fast, transactional, idempotent operation.
- **Asynchronous facts** (funds captured, transaction recorded, notify user, fraud
  score requested): Kafka events via the outbox. Fire-and-forget with at-least-once +
  idempotent consumers.

The saga is **orchestrated by the Payment Service** (explicit state machine:
`REQUESTED → FRAUD_SCREENED → FUNDS_HELD → SUBMITTED_TO_GATEWAY → CAPTURED →
RECORDED → NOTIFIED / FAILED / REVERSED`), not choreographed through six queue pairs —
matching the compensating-actions story you narrated, but with one owner of the state.

### 4.2 FIX — Fraud detection runs only after the money moved
As narrated, fraud scoring happens in parallel with processing and can only
"roll back" a completed payment. Split it:
- **Inline pre-authorization check** (fast rules + model score, hard deadline
  ~100–150 ms, fail-open policy decided per amount tier) **before funds are held**.
  The Fraud Detection table already implies this (`action_taken: Payment Held`).
- **Deep async analysis** post-capture via Kafka for patterns across transactions →
  can trigger reversal saga / step-up MFA / account freeze.

### 4.3 FIX — External gateway call "async to avoid latency" but user "receives confirmation"
Pick per payment method: card-style authorization is **synchronous-ish** (client gets
`processing` → server-sent events / polling to `succeeded`, Stripe-style
PaymentIntent status lifecycle). Never tell the client "confirmed" before the gateway
authorized. The Payments table status enum becomes the PaymentIntent-style lifecycle:
`requires_action | processing | succeeded | failed | canceled | refunded`.

### 4.4 ADD — DLQs and consumer hygiene
Every consumer gets: bounded retries with backoff → dead-letter topic
(`<topic>.dlq`), poison-message quarantine, consumer lag metrics, and idempotent
handling. None of this was in the diagrams.

### 4.5 FIX — Gateway responsibilities
The API Gateway (Traefik) does: TLS termination, routing, rate limiting per user/IP,
JWT verification via ForwardAuth (delegated to a thin auth service consulting JWKS +
Redis denylist), request size limits, CORS. It does **not** hold business logic. The
"Fraud Detection Service → alert → API Gateway" arrow in the diagram becomes a
WebSocket/SSE notification path through the Notification Service instead.

---

## 5. Data-model corrections (table by table)

| Table | Issues → Fixes |
|---|---|
| **users** | `profile_data` free JSON → keep JSONB but field-encrypt PII at rest; `kyc_status` needs enum + audit of transitions; add `mfa_enrolled`, `status` (active/frozen); passwords hashed with **Argon2id** (cost-tuned), never visible in any read model. |
| **accounts** | Becomes `accounts` (identity: id, user_id, currency, status) + `ledger_entries` (append-only) + `account_balances` (materialized: available, held, version) + `holds`. See §2.1–2.2. |
| **payments** | Add `idempotency_key` (unique), `fx_rate_id`, `gateway_ref`, `failure_code`, `merchant_id` FK to a real **merchants** table (referenced in samples but never defined — ADD), amounts in minor units, PaymentIntent-style status enum, `version` for optimistic locking. |
| **transactions** | Keys into ledger entries; `transaction_type` enum gains `hold/capture/release/refund/chargeback/fx_conversion`; immutable — corrections are new reversing entries, never UPDATEs. |
| **exchange_rates** | Append-only with `valid_from`, `source`; single direction per pair. See §2.4. |
| **fraud_logs** | Keep; add `model_version`, `features_snapshot` (JSONB), `decision` enum (approve/hold/deny/step_up); scores are per-decision immutable records. |
| **notifications** | Add `template_id` + `params` instead of free `message_content` (PII minimization); add `channel` retry state; delivery attempts as child table. |
| **sessions (Redis, not Cassandra)** | Sessions are hot, small, TTL'd → Redis is the right store (the narration already uses Redis; the Cassandra "session data" label goes away). Store token **hashes** not raw JWTs. See §3. |
| **audit/event logs (Cassandra)** | Keep Cassandra for the append-heavy audit/event log store; partition by `(entity_id, day_bucket)` to avoid unbounded partitions; TTL per retention policy. Honest note: at small scale this is operational overhead — the compose setup includes it per your vision, but the audit writer goes behind an interface so PostgreSQL can substitute in dev. |
| **payment instruments** | **ADD + PCI scope note:** we never store PANs/CVVs. Card data goes gateway-side (tokenization, SAQ-A style); we keep `instrument_id, gateway_token, brand, last4, exp_month/year`. `payment_method` as free text ("PayPal", "Credit Card") becomes a typed instrument reference. |

Also missing entirely (**ADD**): refunds/chargebacks flow, merchant onboarding &
settlement accounts, reconciliation job (ledger vs gateway reports), webhook delivery
to merchants with signed payloads + retries.

---

## 6. Platform notes

- **Redis serves three roles** (cache, session store, denylist/rate-limit counters) —
  fine at this scale, but logically separated by key prefix + DB index so they can split later.
- **Kafka in KRaft mode** (no ZooKeeper), 3 brokers in the "HA" compose profile, 1 in dev.
- **Every service**: health/readiness endpoints, OpenTelemetry traces/metrics/logs,
  structured JSON logging with correlation ids propagated from the gateway (W3C traceparent).
- **Secrets**: `.env` for dev compose, Azure Key Vault + workload identity in cloud —
  no secrets baked into images.

---

*Next: `docs/architecture.md` (corrected target architecture) and `docs/plan.md`
(service-by-service implementation plan with exact versions from the research sweep).*
