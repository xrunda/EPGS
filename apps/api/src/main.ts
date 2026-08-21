import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

  // Nest-standard DTO validation (class-validator/class-transformer),
  // introduced by issue #4's rules module. whitelist/forbidNonWhitelisted
  // reject unexpected body fields instead of silently dropping them, and
  // transform lets query-string values (page, pageSize, isEnabled) bind
  // to typed DTO properties.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('EPGS API')
    .setDescription(
      'EPGS monitoring API - see /api/rules for issue #4 rule management and /api/monitor for the issue #7 read-only workbench endpoints.',
    )
    .setVersion('0.1.0')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

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
