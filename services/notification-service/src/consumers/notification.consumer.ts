import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { DeliveryAttempt } from '../entities/delivery-attempt.entity.js';
import { Notification } from '../entities/notification.entity.js';
import { CHANNEL_STRATEGIES, type ChannelStrategy } from '../channels/channel.strategy.js';
import { SseHub, type LiveNotification } from '../notifications/sse-hub.service.js';
import { TemplateRegistry } from '../templating/templates.js';
import { unframe } from '../messaging/wire.js';

const GROUP = 'notification-service';

// Shape of a consumed message (the confluent kafkajs-compat payload carries offset).
interface ConsumedMessage {
  key: Buffer | null;
  value: Buffer | null;
  offset: string;
}

// Which fact maps to which template + channels. Payloads carry only what the
// template needs (money as minor units → formatted at render).
const ROUTES: Record<string, { template: string; channels: string[]; map: (p: any) => Record<string, unknown> }> = {
  'identity.user.registered.v1': {
    template: 'welcome',
    channels: ['inapp', 'email'],
    map: (p) => ({ kyc_status: p.kyc_status }),
  },
  'payments.payment.captured.v1': {
    template: 'payment_captured',
    channels: ['inapp', 'email'],
    map: (p) => ({ amount: formatMinor(p.amount_minor_units, p.currency_code), currency: p.currency_code, merchant: p.merchant_id }),
  },
  'payments.payment.failed.v1': {
    template: 'payment_failed',
    channels: ['inapp', 'sms'],
    map: (p) => ({ amount: formatMinor(p.amount_minor_units, p.currency_code), currency: p.currency_code, reason: p.failure_code }),
  },
  'fraud.score.flagged.v1': {
    template: 'fraud_alert',
    channels: ['inapp', 'email'],
    map: (p) => ({ action: p.recommended_action }),
  },
};

@Injectable()
export class NotificationConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationConsumer.name);
  private consumer: KafkaJS.Consumer;
  private producer: KafkaJS.Producer;
  private running = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly templates: TemplateRegistry,
    private readonly hub: SseHub,
    @Inject(CHANNEL_STRATEGIES) private readonly channels: ChannelStrategy[],
    config: ConfigService,
  ) {
    const kafka = new KafkaJS.Kafka({
      kafkaJS: { clientId: GROUP, brokers: config.getOrThrow<string>('KAFKA_BOOTSTRAP_SERVERS').split(',') },
    });
    this.consumer = kafka.consumer({
      kafkaJS: { groupId: GROUP, fromBeginning: true, autoCommit: false },
      // Tolerate a slow group coordinator (resource-constrained brokers):
      // widen the session window and heartbeat often so the consumer isn't
      // evicted mid-rebalance and stuck re-joining.
      'session.timeout.ms': 90000,
      'heartbeat.interval.ms': 3000,
      'max.poll.interval.ms': 300000,
      'reconnect.backoff.max.ms': 10000,
    });
    this.producer = kafka.producer({ kafkaJS: { acks: -1 } });
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: Object.keys(ROUTES) });
    this.running = true;
    void this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        await this.handle(topic, partition, message as ConsumedMessage);
      },
    });
    this.logger.log('notification consumer running');
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.consumer.disconnect().catch(() => undefined);
    await this.producer.disconnect().catch(() => undefined);
  }

  isRunning(): boolean {
    return this.running;
  }

  private async handle(topic: string, partition: number, message: ConsumedMessage): Promise<void> {
    const route = ROUTES[topic];
    if (!route || !message.value) return;

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      try {
        const env = unframe(message.value as Buffer);
        await this.process(env, route);
        await this.consumer.commitOffsets([
          { topic, partition, offset: (Number(message.offset) + 1).toString() },
        ]);
        return;
      } catch (err) {
        this.logger.warn(`handle failed (attempt ${attempt}): ${(err as Error).message}`);
        if (attempt >= 3) {
          const deadLettered = await this.deadLetter(topic, partition, message, err as Error);
          // Commit only once the message is durably parked in the DLQ. Committing
          // after a failed DLQ write would advance past an event stored nowhere.
          if (!deadLettered) {
            this.logger.error(`offset held for redelivery: ${topic}@${message.offset}`);
            return;
          }
          await this.consumer.commitOffsets([
            { topic, partition, offset: (Number(message.offset) + 1).toString() },
          ]);
          return;
        }
        await new Promise((r) => setTimeout(r, attempt * 200));
      }
    }
  }

  private async process(env: ReturnType<typeof unframe>, route: (typeof ROUTES)[string]): Promise<void> {
    const userId = String(env.payload.user_id ?? '');
    if (!userId) return;
    const rendered = this.templates.render(route.template, route.map(env.payload));

    let toPublish: LiveNotification | null = null;
    const em = this.orm.em.fork();
    await em.transactional(async (tem) => {
      // Idempotency gate: insert-or-skip in the same tx as the effect.
      // RETURNING makes the outcome deterministic across driver versions —
      // affectedRows is NOT populated for INSERT..ON CONFLICT here.
      const rows = (await tem
        .getConnection()
        .execute(
          'insert into processed_events (event_id, processed_at) values (?, now()) on conflict do nothing returning event_id',
          [env.event_id],
        )) as unknown[];
      if (!Array.isArray(rows) || rows.length === 0) return; // already processed

      const notification = tem.create(Notification, {
        userId,
        templateId: route.template,
        channel: 'inapp',
        renderedTitle: rendered.title,
        renderedBody: rendered.body,
        params: route.map(env.payload),
      });
      tem.persist(notification);

      for (const channelName of route.channels) {
        const strategy = this.channels.find((c) => c.channel === channelName);
        if (!strategy) continue;
        try {
          await strategy.deliver(tem, { userId, channel: channelName }, rendered);
          tem.persist(tem.create(DeliveryAttempt, {
            notificationId: notification.id,
            channel: channelName,
            status: 'delivered',
            attempt: 1,
          }));
        } catch (err) {
          tem.persist(tem.create(DeliveryAttempt, {
            notificationId: notification.id,
            channel: channelName,
            status: 'failed',
            attempt: 1,
            detail: (err as Error).message,
          }));
        }
      }

      // Staged, not published: emitting inside the transaction would show the
      // subscriber a notification that a failed commit then rolls back.
      toPublish = {
        userId,
        id: notification.id,
        title: rendered.title,
        body: rendered.body,
        channel: 'inapp',
        createdAt: new Date().toISOString(),
      };
    });

    if (toPublish) {
      this.hub.publish(toPublish);
    }
  }

  /** @returns true when the message is durably in the DLQ (safe to commit the offset). */
  private async deadLetter(topic: string, partition: number, message: ConsumedMessage, cause: Error): Promise<boolean> {
    try {
      await this.producer.send({
        topic: `${GROUP}.${topic}.dlq`,
        messages: [
          {
            key: message.key,
            value: message.value,
            headers: {
              'x-exception': cause.message,
              'x-original-topic': topic,
              'x-original-partition': String(partition),
              'x-original-offset': String(message.offset),
              'x-failed-at': new Date().toISOString(),
              'x-consumer-group': GROUP,
            },
          },
        ],
      });
      this.logger.warn(`dead-lettered ${topic}@${message.offset}: ${cause.message}`);
      return true;
    } catch (err) {
      this.logger.error(`DLQ publish failed: ${(err as Error).message}`);
      return false;
    }
  }
}

function formatMinor(minor: unknown, currency: unknown): string {
  const n = Number(minor ?? 0);
  const zeroDecimal = new Set(['JPY', 'KRW', 'VND']);
  if (zeroDecimal.has(String(currency))) return String(n);
  return (n / 100).toFixed(2);
}
