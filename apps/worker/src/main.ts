import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // Same fail-fast contract as apps/api: ConfigModule's Joi validation
  // runs during module instantiation and throws before the process
  // starts listening if required env vars are missing.
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') ?? 3001;

  await app.listen(port);
  logger.log(`EPGS worker listening on port ${port} (internal health/status only)`);
  logger.log('EPGS worker started - sync scheduler active');
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'fatal',
      message: `EPGS worker failed to start: ${message}`,
    }),
  );
  process.exit(1);
});
