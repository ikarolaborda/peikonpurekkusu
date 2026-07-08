package sink

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres sink: append-only, monthly RANGE partitions, idempotent on
// (event_id, occurred_at). Batched via a single multi-row insert.
type Postgres struct {
	pool *pgxpool.Pool
}

func NewPostgres(pool *pgxpool.Pool) *Postgres { return &Postgres{pool: pool} }

func (p *Postgres) Ready(ctx context.Context) error { return p.pool.Ping(ctx) }
func (p *Postgres) Close()                          { p.pool.Close() }

func (p *Postgres) Write(ctx context.Context, batch []Record) error {
	if len(batch) == 0 {
		return nil
	}
	rows := make([][]any, len(batch))
	for i, r := range batch {
		rows[i] = []any{
			r.EventID, r.TenantID, r.EventType, nullable(r.AggregateType),
			nullable(r.EntityType), nullable(r.EntityID), r.OccurredAt,
			nullable(r.CorrelationID), r.Payload,
		}
	}
	// CopyFrom can't express ON CONFLICT, so use a batched insert with the
	// idempotency guard. Duplicate event ids (at-least-once redelivery) are
	// silently ignored.
	b := &pgx.Batch{}
	for _, r := range rows {
		b.Queue(`insert into audit_events
			(event_id, tenant_id, event_type, aggregate_type, entity_type, entity_id, occurred_at, correlation_id, payload)
			values ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9::jsonb)
			on conflict (event_id, occurred_at) do nothing`, r...)
	}
	br := p.pool.SendBatch(ctx, b)
	defer br.Close()
	for range rows {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("audit insert: %w", err)
		}
	}
	return nil
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
