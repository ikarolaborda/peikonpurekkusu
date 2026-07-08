import { defineEntity, type InferEntity } from '@mikro-orm/core';
import { v7 as uuidv7 } from 'uuid';

/**
 * Where the mock email/SMS/push transports "deliver" — a dev-visible sink so
 * the demo can show what would have been sent, without real providers.
 */
export const DevInboxItem = defineEntity({
  name: 'DevInboxItem',
  tableName: 'dev_inbox',
  properties: (p) => ({
    id: p.uuid().primary().onCreate(() => uuidv7()),
    channel: p.string(),
    userId: p.uuid(),
    title: p.string(),
    body: p.text(),
    createdAt: p.datetime().onCreate(() => new Date()),
  }),
});

export type DevInboxItemEntity = InferEntity<typeof DevInboxItem>;
