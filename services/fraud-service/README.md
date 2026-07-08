# fraud-service

Inline pre-authorization scoring (gRPC :9090, ~150 ms caller deadline) plus
post-capture deep analysis. .NET 10 · EF Core 10 · StackExchange.Redis 3 ·
Confluent.Kafka 2.15.

## Scoring pipeline (Chain of Responsibility)

Rules in priority order — `denylist` (hard-deny short-circuit) →
`velocity_count` + `velocity_amount` (exact sliding windows in redis-cache via
one atomic Lua script, event-time based, 20 ms budget) → `amount_tier` →
`geo_mismatch` (recent-countries set) → `ml_score` (pluggable `IFraudScorer`;
`FRAUD_ML_ENABLED=false` runs a deterministic heuristic fallback). Scores
accumulate, `DecisionPolicy` maps to APPROVE / STEP_UP(60) / HOLD(75) /
DENY(90) — thresholds env-tunable.

**Outage policy (Strategy):** a Redis miss makes the affected rule fail open
below `FRAUD_FAIL_CLOSED_THRESHOLD` (flagged, +10) and fail closed at/above it
(+65 → step-up). The caller (payment-service) applies its own amount-tiered
policy on a full outage — both layers, both tiered.

Every evaluation persists to `fraud_logs` (decision, risk score, model
version, features + rule outcomes as jsonb) through a bounded channel + batch
writer so the gRPC path never blocks on the database.

## Async deep analysis

Consumes `payments.payment.captured.v1` (idempotent via `processed_events`,
offsets stored only after durable writes, 3 retries → `fraud-service.<topic>.dlq`)
and flags accounts whose daily captured volume exceeds the threshold →
`fraud.score.flagged.v1` via the transactional outbox (polling relay,
Confluent wire format against Apicurio ccompat).

## Deviations

- Schema via `EnsureCreated` at startup (single-replica dev compose);
  production path is EF migration bundles in a one-shot container.
- ML.NET `PredictionEnginePool` is represented by the `IFraudScorer` seam —
  drop a model behind it without touching the pipeline.
