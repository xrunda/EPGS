import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { SyncModule } from './sync/sync.module';
import { PacsAdapterModule } from './pacs-adapter/pacs-adapter.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: false,
      },
    }),
    HealthModule,
    SyncModule,
    PacsAdapterModule,
  ],
})
export class AppModule {}
