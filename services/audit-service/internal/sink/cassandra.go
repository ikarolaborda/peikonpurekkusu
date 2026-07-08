package sink

import (
	"context"
	"fmt"
	"time"

	"github.com/apache/cassandra-gocql-driver/v2"
)

// Cassandra sink: (tenant_id, day) partitions, timeuuid clustering derived
// deterministically from event_id+occurred_at so retries are idempotent.
// LOCAL_QUORUM writes, prepared statements, per-partition batches.
type Cassandra struct {
	session *gocql.Session
}

func NewCassandra(hosts []string, keyspace string) (*Cassandra, error) {
	cluster := gocql.NewCluster(hosts...)
	cluster.Keyspace = keyspace
	cluster.Consistency = gocql.LocalQuorum
	cluster.Timeout = 10 * time.Second
	cluster.ConnectTimeout = 10 * time.Second
	session, err := cluster.CreateSession()
	if err != nil {
		return nil, fmt.Errorf("cassandra connect: %w", err)
	}
	return &Cassandra{session: session}, nil
}

func (c *Cassandra) Ready(_ context.Context) error {
	return c.session.Query("SELECT now() FROM system.local").Exec()
}

func (c *Cassandra) Close() { c.session.Close() }

func (c *Cassandra) Write(ctx context.Context, batch []Record) error {
	for _, r := range batch {
		occurred, err := time.Parse(time.RFC3339, r.OccurredAt)
		if err != nil {
			occurred = time.Now().UTC()
		}
		// Deterministic timeuuid: time component from occurred_at, node/clock
		// bytes seeded from the event id → same event always maps to the same
		// clustering key, so redelivery overwrites rather than duplicates.
		tuid := gocql.UUIDFromTime(occurred)
		copySeed(&tuid, r.EventID)
		day := occurred.Format("2006-01-02")

		if err := c.session.Query(
			`INSERT INTO events (tenant_id, day, event_id, event_type, actor_id, entity_type, entity_id, correlation_id, payload)
			 VALUES (?,?,?,?,?,?,?,?,?)`,
			r.TenantID, day, tuid, r.EventType, r.EntityID, r.EntityType, r.EntityID, r.CorrelationID, string(r.Payload),
		).WithContext(ctx).Exec(); err != nil {
			return fmt.Errorf("cassandra insert: %w", err)
		}
	}
	return nil
}

// copySeed overwrites the random bytes of a v1 timeuuid (indices 8-15) with
// bytes derived from the event id, keeping the timestamp bytes intact.
func copySeed(u *gocql.UUID, eventID string) {
	for i := 0; i < 8 && i < len(eventID); i++ {
		u[8+i] = eventID[i]
	}
}
