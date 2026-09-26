import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { SyncModule } from './sync/sync.module';
import { PacsAdapterModule } from './pacs-adapter/pacs-adapter.module';
import { PrismaModule } from './prisma/prisma.module';
import { NotificationPushModule } from './notification-push/notification-push.module';
import { AssistantModule } from './assistant/assistant.module';
import { SemanticModule } from './semantic/semantic.module';
import { SemanticReportModule } from './semantic-report/semantic-report.module';

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
    PrismaModule,
    HealthModule,
    SyncModule,
    PacsAdapterModule,
    NotificationPushModule,
    AssistantModule,
    SemanticModule,
    SemanticReportModule,
  ],
})
export class AppModule {}
