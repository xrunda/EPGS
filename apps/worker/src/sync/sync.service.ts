import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

/**
 * Placeholder scheduled job. Real sync/matching logic (PACS/RIS polling,
 * keyword matching, etc.) is implemented in issue #6 - this class only
 * proves the scheduler wiring works end to end by logging a tick.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  @Cron(CronExpression.EVERY_MINUTE)
  handleSyncTick(): void {
    this.logger.log('sync tick');
  }
}
