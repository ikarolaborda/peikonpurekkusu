import { plainToInstance } from 'class-transformer';
import { IsInt, IsString, Min, validateSync } from 'class-validator';

export class Env {
  @IsString() NOTIFICATION_DB_HOST: string = 'notification-db';
  @IsInt() @Min(1) NOTIFICATION_DB_PORT: number = 5432;
  @IsString() NOTIFICATION_DB_USER: string;
  @IsString() NOTIFICATION_DB_PASSWORD: string;
  @IsString() NOTIFICATION_DB_NAME: string;

  @IsString() KAFKA_BOOTSTRAP_SERVERS: string = 'kafka:19092';
  @IsString() SCHEMA_REGISTRY_URL: string = 'http://apicurio-registry:8080/apis/ccompat/v7';
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw, { enableImplicitConversion: true, exposeDefaultValues: true });
  const errors = validateSync(env, { whitelist: true });
  if (errors.length > 0) {
    throw new Error(
      `notification-service env validation failed:\n${errors
        .map((e) => Object.values(e.constraints ?? {}).join(', '))
        .join('\n')}`,
    );
  }
  return env;
}
