import { MikroORM } from '@mikro-orm/postgresql';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('bootstrap');
  app.enableShutdownHooks();

  const orm = app.get(MikroORM);
  await orm.migrator.up();
  logger.log('migrations applied');

  await app.listen(8080, '0.0.0.0');
  logger.log('notification-service listening on :8080');
}

void bootstrap();
