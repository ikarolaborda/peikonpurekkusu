import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import mikroOrmConfig from '../mikro-orm.config.js';
import {
  CHANNEL_STRATEGIES,
  EmailTransport,
  InAppTransport,
  PushTransport,
  SmsTransport,
} from './channels/channel.strategy.js';
import { validateEnv } from './config/env.validation.js';
import { NotificationConsumer } from './consumers/notification.consumer.js';
import { DeliveryAttempt } from './entities/delivery-attempt.entity.js';
import { DevInboxItem } from './entities/dev-inbox.entity.js';
import { Notification } from './entities/notification.entity.js';
import { OutboxEvent } from './entities/outbox-event.entity.js';
import { ProcessedEvent } from './entities/processed-event.entity.js';
import { HealthController } from './health/health.controller.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { SseHub } from './notifications/sse-hub.service.js';
import { TemplateRegistry } from './templating/templates.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    MikroOrmModule.forRoot(mikroOrmConfig),
    MikroOrmModule.forFeature([Notification, DeliveryAttempt, DevInboxItem, ProcessedEvent, OutboxEvent]),
    TerminusModule,
  ],
  controllers: [NotificationsController, HealthController],
  providers: [
    TemplateRegistry,
    SseHub,
    NotificationConsumer,
    {
      provide: CHANNEL_STRATEGIES,
      useValue: [new InAppTransport(), new EmailTransport(), new SmsTransport(), new PushTransport()],
    },
  ],
})
export class AppModule {}
