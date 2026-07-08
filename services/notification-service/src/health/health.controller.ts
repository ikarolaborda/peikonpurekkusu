import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { NotificationConsumer } from '../consumers/notification.consumer.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    private readonly orm: MikroORM,
    private readonly consumer: NotificationConsumer,
  ) {}

  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      async () => {
        const ind = this.indicator.check('postgres');
        return (await this.orm.isConnected()) ? ind.up() : ind.down();
      },
      async () => {
        const ind = this.indicator.check('consumer');
        return this.consumer.isRunning() ? ind.up() : ind.down();
      },
    ]);
  }
}
