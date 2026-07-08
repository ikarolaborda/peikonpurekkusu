import { defineEntity, type InferEntity } from '@mikro-orm/core';
import { v7 as uuidv7 } from 'uuid';

/** A rendered, user-facing notification (the in-app inbox row). */
export const Notification = defineEntity({
  name: 'Notification',
  tableName: 'notifications',
  properties: (p) => ({
    id: p.uuid().primary().onCreate(() => uuidv7()),
    userId: p.uuid().index(),
    templateId: p.string(),
    channel: p.string(), // email | sms | push | inapp
    renderedTitle: p.string(),
    renderedBody: p.text(),
    /** template params (no raw PII beyond what the template needs) */
    params: p.json().$type<Record<string, unknown>>(),
    readAt: p.datetime().nullable(),
    createdAt: p.datetime().onCreate(() => new Date()),
  }),
});

export type NotificationEntity = InferEntity<typeof Notification>;
