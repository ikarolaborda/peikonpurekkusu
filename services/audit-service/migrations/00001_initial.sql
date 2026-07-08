-- +goose Up

-- Partition bounds are timestamptz literals: pin the session timezone so the
-- boundaries land exactly on UTC month edges regardless of server config.
set timezone to 'UTC';

-- Append-only audit firehose. Native RANGE partitioning by month on
-- occurred_at keeps old months cheap to detach/drop; a partitioned-table
-- primary key MUST include the partition key, hence (event_id, occurred_at).
-- Idempotent ingestion relies on ON CONFLICT (event_id, occurred_at) DO NOTHING.
create table audit_events (
  event_id       uuid not null,
  tenant_id      text not null default 'peikon',
  event_type     text not null,
  aggregate_type text,
  actor_id       text,
  entity_type    text,
  entity_id      text,
  occurred_at    timestamptz not null,
  correlation_id text,
  payload        jsonb not null default '{}'::jsonb,
  recorded_at    timestamptz not null default now(),
  primary key (event_id, occurred_at)
) partition by range (occurred_at);

-- Pre-create 25 monthly partitions: 2026-07 .. 2028-07 inclusive.
-- Keep in sync with sink.PartitionFor (internal/sink/sink.go).
-- +goose StatementBegin
do $$
declare
  m date := date '2026-07-01';
begin
  for i in 0..24 loop
    execute format(
      'create table if not exists audit_events_%s partition of audit_events for values from (%L) to (%L)',
      to_char(m, '"y"YYYY"m"MM'), m, m + interval '1 month');
    m := m + interval '1 month';
  end loop;
end
$$;
-- +goose StatementEnd

-- Catch-all so writes outside the pre-created range never fail (the sink
-- logs loudly when rows land here — it means the partition set needs care).
create table audit_events_default partition of audit_events default;

-- BRIN: occurred_at correlates with physical insert order per partition —
-- tiny index, fast time-range scans over an append-only firehose.
create index audit_events_occurred_brin on audit_events using brin (occurred_at);
-- Entity lookup path (mirrors the Cassandra SAI index on entity_id).
create index audit_events_entity_idx on audit_events (entity_id) where entity_id is not null;

-- +goose Down
drop table if exists audit_events cascade;
