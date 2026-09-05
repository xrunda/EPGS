import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AlertLinkExamListDto,
  AlertLinkLevelDto,
  AlertLinkSummaryDto,
  MonitorExamDetailDto,
} from '@epgs/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { MonitorService } from '../monitor/monitor.service';
import { MonitorRecordNotFoundException } from '../monitor/errors/monitor-record-not-found.exception';
import { maskAlertExamDetail, maskAlertExamRow } from './alert-link-masking';
import { ResolvedAlertLink } from './alert-link.types';

/**
 * Read-only queries behind the alert H5 page (issue #72). Every method takes
 * the guard-resolved link and treats `link.recordIds` as the authorization
 * boundary: the list is exactly that id set, and a detail outside it is a
 * 404 (MONITOR_RECORD_NOT_FOUND - the same "never reveal it exists" semantics
 * issue #13 uses for out-of-scope ids). No audit_log row is written (there is
 * no AppRole actor); `open()` bumps the link's open counter instead.
 */
@Injectable()
export class AlertLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly monitor: MonitorService,
    private readonly config: ConfigService,
  ) {}

  /** Summary for the page header; counts as one "open" of the link. */
  async open(link: ResolvedAlertLink, now: Date = new Date()): Promise<AlertLinkSummaryDto> {
    await this.prisma.alertLink.update({
      where: { id: link.id },
      data: { openCount: { increment: 1 }, lastOpenedAt: now },
      select: { id: true },
    });
    return {
      level: link.level as AlertLinkLevelDto,
      windowDate: link.windowDate,
      total: link.recordIds.length,
      createdAt: link.createdAt.toISOString(),
      expiresAt: link.expiresAt.toISOString(),
      hospitalName: this.config.get<string>('hospitalName') ?? '菏泽市中医医院',
    };
  }

  /** The snapshot's rows (name masked, bed/department kept). */
  async listExams(link: ResolvedAlertLink): Promise<AlertLinkExamListDto> {
    const items = (await this.monitor.listByIds(link.recordIds)).map(maskAlertExamRow);
    return { items, total: items.length };
  }

  /** One snapshot record's full detail (name masked, report + hits kept). */
  async getExamDetail(link: ResolvedAlertLink, id: string): Promise<MonitorExamDetailDto> {
    if (!link.recordIds.includes(id)) throw new MonitorRecordNotFoundException(id);
    return maskAlertExamDetail(await this.monitor.getDetail(id));
  }
}
