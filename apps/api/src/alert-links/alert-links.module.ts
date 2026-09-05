import { Module } from '@nestjs/common';
import { MonitorModule } from '../monitor/monitor.module';
import { AlertLinkGuard } from './alert-link.guard';
import { AlertLinksController } from './alert-links.controller';
import { AlertLinksService } from './alert-links.service';

/**
 * Issue #72: the read-only endpoints behind the WeCom alert H5 page. Imports
 * MonitorModule for MonitorService (listByIds / getDetail); PrismaModule is
 * @Global. Link ISSUANCE lives in NotificationsModule/worker (it happens
 * during a push run), this module only resolves and reads links.
 */
@Module({
  imports: [MonitorModule],
  controllers: [AlertLinksController],
  providers: [AlertLinksService, AlertLinkGuard],
})
export class AlertLinksModule {}
