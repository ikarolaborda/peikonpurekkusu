import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { DeliveryAttempt } from './src/entities/delivery-attempt.entity.js';
import { DevInboxItem } from './src/entities/dev-inbox.entity.js';
import { Notification } from './src/entities/notification.entity.js';
import { OutboxEvent } from './src/entities/outbox-event.entity.js';
import { ProcessedEvent } from './src/entities/processed-event.entity.js';

export default defineConfig({
  host: process.env.NOTIFICATION_DB_HOST ?? 'notification-db',
  port: Number(process.env.NOTIFICATION_DB_PORT ?? 5432),
  user: process.env.NOTIFICATION_DB_USER,
  password: process.env.NOTIFICATION_DB_PASSWORD,
  dbName: process.env.NOTIFICATION_DB_NAME,
  entities: [Notification, DeliveryAttempt, DevInboxItem, ProcessedEvent, OutboxEvent],
  extensions: [Migrator],
  migrations: { path: 'dist/src/migrations', pathTs: 'src/migrations', transactional: true, allOrNothing: true, snapshot: false },
  forceUtcTimezone: true,
});
