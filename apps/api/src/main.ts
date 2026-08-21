import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { AppLoggerService } from './common/logger/app-logger.service';

async function bootstrap(): Promise<void> {
  const logger = new AppLoggerService();
  logger.setContext('Bootstrap');

  // NestFactory.create runs ConfigModule's Joi validation synchronously
  // during module instantiation. If required env vars are missing, this
  // throws here and the process exits before listening on any port -
  // this is our fail-fast guarantee.
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  app.useGlobalFilters(new GlobalExceptionFilter());

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') ?? 3000;

  await app.listen(port);
  logger.log(`EPGS API listening on port ${port}`);
}

bootstrap().catch((error: unknown) => {
  // Fail fast: log a non-secret-leaking message and exit with a
  // non-zero code so orchestrators (docker, CI, systemd) see the failure.
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'fatal',
      message: `EPGS API failed to start: ${message}`,
    }),
  );
  process.exit(1);
});
