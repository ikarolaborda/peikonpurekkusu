-- peikonpurekkusu audit keyspace (idempotent; dev: RF=1 single node — prod floor is 3 nodes / RF=3)
CREATE KEYSPACE IF NOT EXISTS audit
  WITH replication = {'class': 'NetworkTopologyStrategy', 'datacenter1': 1};

-- Append-only audit events.
-- Partition: (tenant_id, day) — bounded daily buckets. Clustering: timeuuid DESC.
-- TWCS windows == bucket size; table-level TTL (400 days) lets whole SSTables expire.
CREATE TABLE IF NOT EXISTS audit.events (
  tenant_id    text,
  day          date,
  event_id     timeuuid,
  event_type   text,
  actor_id     text,
  entity_type  text,
  entity_id    text,
  correlation_id text,
  payload      text,
  PRIMARY KEY ((tenant_id, day), event_id)
) WITH CLUSTERING ORDER BY (event_id DESC)
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 1
  }
  AND default_time_to_live = 34560000;

-- Secondary access path: events by entity (SAI, Cassandra 5)
CREATE INDEX IF NOT EXISTS events_entity_idx
  ON audit.events (entity_id) USING 'sai';
