import { Injectable } from '@nestjs/common';
import {
  ALERT_LINK_LEVELS,
  AlertLinkLevel,
  AlertLinkStore,
  CreateAlertLinkInput,
  resolveShanghaiDayRange,
} from '@epgs/notification-push';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Prisma-backed AlertLinkStore for the worker's scheduled runs (issue #72),
 * the counterpart of apps/api's PrismaAlertLinkStore over the worker's own
 * client. The snapshot query uses the SAME day window as WorkerSummaryProvider
 * (resolveShanghaiDayRange) so a card's count equals the pushed summary count.
 * Like the summary provider, the worker runs unscoped: `scope` is accepted for
 * interface compatibility and ignored. Only ids are read - never patient
 * columns - and only the token HASH is written.
 */
@Injectable()
export class WorkerAlertLinkStore implements AlertLinkStore {
  constructor(private readonly prisma: PrismaService) {}

  async listRecordIdsByLevel(input: {
    windowDate: string;
    scope?: string[];
  }): Promise<Partial<Record<AlertLinkLevel, string[]>>> {
    const range = resolveShanghaiDayRange(input.windowDate);
    const rows = await this.prisma.monitorRecord.findMany({
      where: {
        examTime: { gte: range.gte, lt: range.lt },
        currentLevel: { in: [...ALERT_LINK_LEVELS] },
      },
      select: { id: true, currentLevel: true },
      orderBy: [{ examTime: 'desc' }, { id: 'asc' }],
    });

    const result: Partial<Record<AlertLinkLevel, string[]>> = {};
    for (const row of rows) {
      const level = row.currentLevel as AlertLinkLevel;
      if (!ALERT_LINK_LEVELS.includes(level)) continue;
      (result[level] ??= []).push(row.id);
    }
    return result;
  }

  async createAlertLink(input: CreateAlertLinkInput): Promise<{ id: string }> {
    const row = await this.prisma.alertLink.create({
      data: {
        tokenHash: input.tokenHash,
        level: input.level,
        windowDate: input.windowDate,
        pushLogId: input.pushLogId,
        recordIds: input.recordIds,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      },
      select: { id: true },
    });
    return { id: row.id };
  }
}
