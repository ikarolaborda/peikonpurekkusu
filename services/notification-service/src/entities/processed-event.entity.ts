import { defineEntity, type InferEntity } from '@mikro-orm/core';

/** Consumer idempotency ledger — dedup on event_id in the same tx as the effect. */
export const ProcessedEvent = defineEntity({
  name: 'ProcessedEvent',
  tableName: 'processed_events',
  properties: (p) => ({
    eventId: p.uuid().primary(),
    processedAt: p.datetime().onCreate(() => new Date()),
  }),
});

export type ProcessedEventEntity = InferEntity<typeof ProcessedEvent>;
