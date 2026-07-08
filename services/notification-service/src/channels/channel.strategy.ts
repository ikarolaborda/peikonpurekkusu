import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable, Logger } from '@nestjs/common';
import { DevInboxItem } from '../entities/dev-inbox.entity.js';
import type { RenderedTemplate } from '../templating/templates.js';

export interface DeliveryTarget {
  userId: string;
  channel: string;
}

/**
 * Channel delivery Strategy. `inapp` is the primary (the notification row IS
 * the delivery); email/sms/push are mock transports that write to a
 * dev-visible inbox instead of contacting real providers.
 */
export interface ChannelStrategy {
  readonly channel: string;
  deliver(em: EntityManager, target: DeliveryTarget, message: RenderedTemplate): Promise<void>;
}

@Injectable()
export class InAppTransport implements ChannelStrategy {
  readonly channel = 'inapp';
  // The notification row persisted by the consumer is itself the in-app
  // delivery; nothing more to do here.
  async deliver(): Promise<void> {}
}

class MockTransport implements ChannelStrategy {
  private readonly logger: Logger;
  constructor(readonly channel: string) {
    this.logger = new Logger(`MockTransport:${channel}`);
  }

  async deliver(em: EntityManager, target: DeliveryTarget, message: RenderedTemplate): Promise<void> {
    em.persist(
      em.create(DevInboxItem, {
        channel: this.channel,
        userId: target.userId,
        title: message.title,
        body: message.body,
      }),
    );
    this.logger.log(`[${this.channel}] → ${target.userId.slice(0, 8)}…: ${message.title}`);
  }
}

export class EmailTransport extends MockTransport {
  constructor() {
    super('email');
  }
}
export class SmsTransport extends MockTransport {
  constructor() {
    super('sms');
  }
}
export class PushTransport extends MockTransport {
  constructor() {
    super('push');
  }
}

export const CHANNEL_STRATEGIES = Symbol('CHANNEL_STRATEGIES');
