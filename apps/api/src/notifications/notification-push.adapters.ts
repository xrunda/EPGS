import { Injectable } from '@nestjs/common';
import { Prisma, NotificationChannel, NotificationTemplate, PushLog } from '@prisma/client';
import {
  ALERT_LINK_LEVELS,
  AlertLinkLevel,
  AlertLinkStore,
  CreateAlertLinkInput,
  KeywordHit,
  NotificationPushStore,
  NotificationSummaryProvider,
  PushChannel,
  PushLogRow,
  PushRule,
  PushSummary,
  PushTemplate,
  resolveShanghaiDayRange,
  CreatePushLogInput,
  CreatePushDeliveryInput,
  CompletePushLogInput,
  ScheduledPushAlreadyExistsError,
} from '@epgs/notification-push';
import { PrismaService } from '../prisma/prisma.service';
import { MonitorService } from '../monitor/monitor.service';

type RuleRow = Prisma.NotificationRuleGetPayload<{
  include: {
    template: true;
    ruleChannels: { include: { channel: true } };
  };
}>;

/**
 * Prisma-backed NotificationPushStore for the api (issue: push rules).
 *
 * Lives beside the rule endpoints (not in the shared package) because the
 * store interface is deliberately @prisma/client-free: each app owns its own
 * generated client, and this adapter is the only place that knows how to
 * translate Prisma rows into the shared structural shapes.
 *
 * createPushLog maps the partial unique index uq_push_log_scheduled_dedup's
 * P2002 conflict to ScheduledPushAlreadyExistsError - the DB-level race
 * backstop behind the executor's app-layer dedup guard. MANUAL rows never hit
 * that index, so a P2002 on a MANUAL insert is a genuine fault and rethrows.
 */
@Injectable()
export class PrismaNotificationPushStore implements NotificationPushStore {
  constructor(private readonly prisma: PrismaService) {}

  async getRule(ruleId: string): Promise<PushRule | null> {
    const rule = await this.prisma.notificationRule.findUnique({
      where: { id: ruleId },
      include: { template: true, ruleChannels: { include: { channel: true } } },
    });
    return rule ? toPushRule(rule) : null;
  }

  async listEnabledRules(): Promise<PushRule[]> {
    const rules = await this.prisma.notificationRule.findMany({
      where: { isEnabled: true },
      include: { template: true, ruleChannels: { include: { channel: true } } },
    });
    return rules.map(toPushRule);
  }

  async getChannel(channelId: string): Promise<PushChannel | null> {
    const channel = await this.prisma.notificationChannel.findUnique({ where: { id: channelId } });
    return channel ? toPushChannel(channel) : null;
  }

  async getTemplate(templateId: string): Promise<PushTemplate | null> {
    const template = await this.prisma.notificationTemplate.findUnique({ where: { id: templateId } });
    return template ? toPushTemplate(template) : null;
  }

  async findScheduledPush(ruleId: string, windowDate: string): Promise<PushLogRow | null> {
    const row = await this.prisma.pushLog.findFirst({
      where: { ruleId, windowDate, trigger: 'SCHEDULED' },
      orderBy: { startedAt: 'desc' },
    });
    return row ? toPushLogRow(row) : null;
  }

  async createPushLog(input: CreatePushLogInput): Promise<PushLogRow> {
    try {
      const row = await this.prisma.pushLog.create({
        data: {
          ruleId: input.ruleId,
          windowDate: input.windowDate,
          trigger: input.trigger,
          startedAt: input.startedAt,
        },
      });
      return toPushLogRow(row);
    } catch (error) {
      if (input.trigger === 'SCHEDULED' && isUniqueViolation(error)) {
        throw new ScheduledPushAlreadyExistsError(input.ruleId, input.windowDate);
      }
      throw error;
    }
  }

  async createPushDelivery(input: CreatePushDeliveryInput): Promise<{ id: string }> {
    const row = await this.prisma.pushDelivery.create({ data: { ...input } });
    return { id: row.id };
  }

  async completePushLog(input: CompletePushLogInput): Promise<void> {
    await this.prisma.pushLog.update({
      where: { id: input.pushLogId },
      data: { status: input.status, finishedAt: input.finishedAt, errorSummary: input.errorSummary },
    });
  }
}

/**
 * Adapts the workbench's MonitorService.summary as the shared pipeline's
 * summary provider, so a push message carries EXACTLY the counts the 监控看板
 * shows for the same department scope (issue: push rules). `date` present =
 * "今日新报告" window; absent = full inventory.
 */
@Injectable()
export class MonitorSummaryProvider implements NotificationSummaryProvider {
  constructor(
    private readonly monitor: MonitorService,
    private readonly prisma: PrismaService,
  ) {}

  async get(input: { date?: string; scope?: string[] }): Promise<PushSummary> {
    const summary = input.date
      ? await this.monitor.summary({ examDateFrom: input.date, examDateTo: input.date }, { scope: input.scope })
      : await this.monitor.summary({}, { scope: input.scope });

    // Issue #69: keyword hits in the same window as the counts, honoring the
    // same department scope MonitorService.summary applies. Counts MATCHES
    // (monitor_match rows), not records - a record matching two keywords
    // contributes one hit to each. Matches referencing a since-superseded or
    // disabled rule version are excluded (active classification only).
    const range = input.date !== undefined ? resolveShanghaiDayRange(input.date) : undefined;
    const keywordHits = await this.aggregateKeywordHits(range, input.scope);

    return {
      total: summary.total,
      red: summary.red,
      yellow: summary.yellow,
      green: summary.green,
      unclassified: summary.unclassified,
      keywordHits,
    };
  }

  private async aggregateKeywordHits(
    range: { gte: Date; lt: Date } | undefined,
    scope: string[] | undefined,
  ): Promise<KeywordHit[]> {
    const rows = await this.prisma.monitorMatch.groupBy({
      by: ['keyword', 'level'],
      where: {
        record: {
          ...(range ? { examTime: range } : {}),
          ...(scope && scope.length > 0 ? { department: { in: scope } } : {}),
        },
        rule: { isEnabled: true },
      },
      _count: { _all: true },
    });
    return rows.map((row) => ({
      keyword: row.keyword,
      level: row.level,
      count: row._count._all,
    }));
  }
}

/**
 * Prisma-backed AlertLinkStore for the api's manual "run now" (issue #72).
 * The snapshot query uses the SAME window + department-scope conditions as
 * MonitorSummaryProvider above, so a card's count equals the summary count
 * the operator sees. Only ids are read - never patient columns.
 */
@Injectable()
export class PrismaAlertLinkStore implements AlertLinkStore {
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
        ...(input.scope && input.scope.length > 0 ? { department: { in: input.scope } } : {}),
      },
      select: { id: true, currentLevel: true },
      orderBy: [{ examTime: 'desc' }, { id: 'asc' }],
    });
    return groupIdsByLevel(rows);
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

export function groupIdsByLevel(
  rows: { id: string; currentLevel: string }[],
): Partial<Record<AlertLinkLevel, string[]>> {
  const result: Partial<Record<AlertLinkLevel, string[]>> = {};
  for (const row of rows) {
    const level = row.currentLevel as AlertLinkLevel;
    if (!ALERT_LINK_LEVELS.includes(level)) continue;
    (result[level] ??= []).push(row.id);
  }
  return result;
}

function toPushChannel(channel: NotificationChannel): PushChannel {
  return {
    id: channel.id,
    name: channel.name,
    webhookUrlCiphertext: channel.webhookUrlCiphertext,
    isEnabled: channel.isEnabled,
  };
}

function toPushTemplate(template: NotificationTemplate): PushTemplate {
  return {
    id: template.id,
    msgType: template.msgType,
    titleTemplate: template.titleTemplate,
    contentTemplate: template.contentTemplate,
    coverImageUrl: template.coverImageUrl,
    linkUrl: template.linkUrl,
    isEnabled: template.isEnabled,
  };
}

function toPushRule(rule: RuleRow): PushRule {
  return {
    id: rule.id,
    name: rule.name,
    cron: rule.cron,
    isEnabled: rule.isEnabled,
    template: toPushTemplate(rule.template),
    channels: rule.ruleChannels.map((ruleChannel) => ({
      id: ruleChannel.id,
      channelId: ruleChannel.channelId,
      channel: toPushChannel(ruleChannel.channel),
    })),
  };
}

function toPushLogRow(row: PushLog): PushLogRow {
  return {
    id: row.id,
    ruleId: row.ruleId,
    windowDate: row.windowDate,
    trigger: row.trigger,
    status: row.status,
    errorSummary: row.errorSummary,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
