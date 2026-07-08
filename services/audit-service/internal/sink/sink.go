// Package sink is the audit persistence layer behind an Adapter interface, so
// the store (PostgreSQL partitioned table, or Cassandra) is a config choice —
// AUDIT_SINK — not a code dependency. Both sinks are idempotent on event_id
// and batch writes.
package sink

import (
	"context"

	"github.com/peikonpurekkusu/audit-service/internal/events"
)

// Record is one audit row derived from an event envelope.
type Record struct {
	EventID       string
	TenantID      string
	EventType     string
	AggregateType string
	EntityType    string
	EntityID      string
	OccurredAt    string // RFC3339
	CorrelationID string
	Payload       []byte // raw envelope payload JSON
}

// Sink persists a batch of audit records idempotently.
type Sink interface {
	Write(ctx context.Context, batch []Record) error
	Ready(ctx context.Context) error
	Close()
}

// FromEnvelope projects an event envelope into an audit record, pulling common
// entity hints from the payload when present (tolerant of any event shape).
func FromEnvelope(env events.Envelope, rawPayload []byte) Record {
	return Record{
		EventID:       env.EventID,
		TenantID:      env.TenantID,
		EventType:     env.EventType,
		AggregateType: aggregateType(env.EventType),
		EntityType:    entityType(env.Payload),
		EntityID:      entityID(env.Payload),
		OccurredAt:    env.OccurredAt.UTC().Format("2006-01-02T15:04:05.999999Z07:00"),
		CorrelationID: env.CorrelationID,
		Payload:       rawPayload,
	}
}

func aggregateType(eventType string) string {
	// domain is the first dot-segment of <domain>.<aggregate>.<event>.vN
	for i := 0; i < len(eventType); i++ {
		if eventType[i] == '.' {
			return eventType[:i]
		}
	}
	return eventType
}

func entityID(payload map[string]any) string {
	for _, k := range []string{"payment_id", "account_id", "user_id", "transaction_id", "hold_id", "notification_id"} {
		if v, ok := payload[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func entityType(payload map[string]any) string {
	for _, k := range []string{"payment_id", "account_id", "user_id", "transaction_id", "hold_id", "notification_id"} {
		if v, ok := payload[k].(string); ok && v != "" {
			return k[:len(k)-3] // strip "_id"
		}
	}
	return ""
}
