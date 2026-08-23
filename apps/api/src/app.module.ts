import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { MonitorModule } from './monitor/monitor.module';
import { PrismaModule } from './prisma/prisma.module';
import { RulesModule } from './rules/rules.module';
import { SystemModule } from './system/system.module';
import { AuthModule } from './auth/auth.module';
import { AccessModule } from './access/access.module';
import { AuditModule } from './audit/audit.module';
import { NotificationsModule } from './notifications/notifications.module';

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
    // AuthGuard (#31) must register before AccessModule's RolesGuard, so
    // AccessModule is imported after AuthModule - see access/roles.guard.ts.
    AuthModule,
    AccessModule,
    AuditModule,
    HealthModule,
    MonitorModule,
    NotificationsModule,
    RulesModule,
    SystemModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
