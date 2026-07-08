// Package consumer reads the full event firehose and writes every envelope to
// the configured audit sink. Batched (flush every 2s or 100 events), tolerant
// of unknown event types (audit stores everything), unparseable frames → DLQ.
package consumer

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"

	"github.com/peikonpurekkusu/audit-service/internal/events"
	"github.com/peikonpurekkusu/audit-service/internal/sink"
)

const group = "audit-service"

type Consumer struct {
	client   *kgo.Client
	producer *kgo.Client
	sink     sink.Sink
	log      *slog.Logger
}

func New(bootstrap, topics []string, s sink.Sink, producer *kgo.Client, log *slog.Logger) (*Consumer, error) {
	client, err := kgo.NewClient(
		kgo.SeedBrokers(bootstrap...),
		kgo.ConsumerGroup(group),
		kgo.ConsumeTopics(topics...),
		kgo.DisableAutoCommit(),
		kgo.FetchMaxWait(2*time.Second),
	)
	if err != nil {
		return nil, err
	}
	return &Consumer{client: client, producer: producer, sink: s, log: log}, nil
}

func (c *Consumer) Close() { c.client.Close() }

func (c *Consumer) Run(ctx context.Context) {
	for {
		fetches := c.client.PollFetches(ctx)
		if ctx.Err() != nil {
			return
		}
		if errs := fetches.Errors(); len(errs) > 0 {
			for _, e := range errs {
				c.log.Error("kafka fetch error", "topic", e.Topic, "error", e.Err)
			}
			time.Sleep(time.Second)
			continue
		}

		batch := make([]sink.Record, 0, 100)
		var poison []*kgo.Record
		fetches.EachRecord(func(rec *kgo.Record) {
			env, err := events.Unframe(rec.Value)
			if err != nil {
				poison = append(poison, rec)
				return
			}
			payload, _ := json.Marshal(env.Payload)
			batch = append(batch, sink.FromEnvelope(env, payload))
		})

		if len(batch) > 0 {
			if err := c.sink.Write(ctx, batch); err != nil {
				// Don't advance offsets — the whole fetch is reprocessed.
				c.log.Error("audit sink write failed (will reprocess)", "count", len(batch), "error", err)
				time.Sleep(time.Second)
				continue
			}
		}
		for _, rec := range poison {
			c.deadLetter(ctx, rec)
		}
		if err := c.client.CommitUncommittedOffsets(ctx); err != nil {
			c.log.Error("offset commit failed", "error", err)
		}
	}
}

func (c *Consumer) deadLetter(ctx context.Context, rec *kgo.Record) {
	err := c.producer.ProduceSync(ctx, &kgo.Record{
		Topic: group + ".firehose.dlq",
		Key:   rec.Key,
		Value: rec.Value,
		Headers: append(rec.Headers,
			kgo.RecordHeader{Key: "x-exception", Value: []byte("unparseable envelope")},
			kgo.RecordHeader{Key: "x-original-topic", Value: []byte(rec.Topic)},
			kgo.RecordHeader{Key: "x-failed-at", Value: []byte(time.Now().UTC().Format(time.RFC3339))},
		),
	}).FirstErr()
	if err != nil {
		c.log.Error("DLQ publish failed", "error", err)
		return
	}
	c.log.Warn("unparseable event dead-lettered", "topic", rec.Topic)
}
