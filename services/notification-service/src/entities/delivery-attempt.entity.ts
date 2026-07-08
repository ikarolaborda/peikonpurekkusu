import { defineEntity, type InferEntity } from '@mikro-orm/core';
import { v7 as uuidv7 } from 'uuid';

/** One delivery attempt per channel for a notification (retry/backoff state). */
export const DeliveryAttempt = defineEntity({
  name: 'DeliveryAttempt',
  tableName: 'delivery_attempts',
  properties: (p) => ({
    id: p.uuid().primary().onCreate(() => uuidv7()),
    notificationId: p.uuid().index(),
    channel: p.string(),
    status: p.string(), // delivered | failed
    attempt: p.integer(),
    detail: p.string().nullable(),
    createdAt: p.datetime().onCreate(() => new Date()),
  }),
});

export type DeliveryAttemptEntity = InferEntity<typeof DeliveryAttempt>;
