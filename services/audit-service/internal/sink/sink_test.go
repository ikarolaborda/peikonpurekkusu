package sink

import (
	"testing"
	"time"

	"github.com/peikonpurekkusu/audit-service/internal/events"
)

func TestFromEnvelopeProjectsEntityAndDomain(t *testing.T) {
	env := events.NewEnvelope("e1", "payments.payment.captured.v1", "corr-1", time.Now(), map[string]any{
		"payment_id": "pay-123",
		"account_id": "acc-456",
	})
	rec := FromEnvelope(env, []byte(`{"payment_id":"pay-123"}`))

	if rec.AggregateType != "payments" {
		t.Fatalf("domain: want payments, got %q", rec.AggregateType)
	}
	// payment_id is the first-preferred entity hint
	if rec.EntityType != "payment" || rec.EntityID != "pay-123" {
		t.Fatalf("entity: want payment/pay-123, got %s/%s", rec.EntityType, rec.EntityID)
	}
	if rec.EventID != "e1" || rec.EventType != "payments.payment.captured.v1" {
		t.Fatalf("envelope fields not carried through: %+v", rec)
	}
}

func TestFromEnvelopeToleratesUnknownShape(t *testing.T) {
	env := events.NewEnvelope("e2", "some.new.event.v1", "corr", time.Now(), map[string]any{"foo": "bar"})
	rec := FromEnvelope(env, []byte(`{"foo":"bar"}`))
	if rec.AggregateType != "some" {
		t.Fatalf("want domain 'some', got %q", rec.AggregateType)
	}
	if rec.EntityID != "" {
		t.Fatalf("no known entity id expected, got %q", rec.EntityID)
	}
}
