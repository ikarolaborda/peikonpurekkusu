# audit-service

Consumes the entire event firehose and writes an append-only audit log.
Go 1.26 · franz-go. Sink is a config choice, not a code dependency.

## Sink adapter (`AUDIT_SINK`)

- **postgres** (default) — `audit_events` with native monthly RANGE
  partitioning on `occurred_at` (PK `(event_id, occurred_at)` — partition key
  must be in the PK), BRIN index on `occurred_at`, partial index on
  `entity_id`. Idempotent via `ON CONFLICT DO NOTHING`. Old months detach/drop
  cheaply. goose-embedded migration pre-creates 25 monthly partitions + a
  default catch-all.
- **cassandra** — `audit.events` keyed `(tenant_id, day)` with a timeuuid
  clustering key derived deterministically from `event_id`+`occurred_at` (so
  redelivery overwrites, never duplicates), LOCAL_QUORUM. Fully implemented;
  the service starts cleanly on postgres when Cassandra isn't running
  (Cassandra is profile-gated on the 8GB dev VM).

## Behavior

Subscribes to all 18 `*.v1` topics (override with `AUDIT_TOPICS`). Tolerant of
unknown event shapes — audit stores everything; entity/domain hints are
projected from the envelope when present. Batched writes (per fetch);
unparseable frames → `audit-service.firehose.dlq`. A sink write failure leaves
offsets uncommitted so the batch reprocesses — never silently dropped.
Health-only HTTP (`/health/live`, `/health/ready` pings the active sink).

## Patterns map

- **Adapter** — `sink.Sink` with Postgres / Cassandra implementations,
  selected by `AUDIT_SINK`
- **Transactional Outbox** consumer side: idempotent ingestion keyed by
  `event_id`
