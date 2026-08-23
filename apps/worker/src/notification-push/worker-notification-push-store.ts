import { Injectable } from '@nestjs/common';
import { Prisma, NotificationChannel, NotificationTemplate, PushLog } from '@prisma/client';
import {
  NotificationPushStore,
  PushChannel,
  PushLogRow,
  PushRule,
  PushTemplate,
  CreatePushLogInput,
  CreatePushDeliveryInput,
  CompletePushLogInput,
  ScheduledPushAlreadyExistsError,
} from '@epgs/notification-push';
import { PrismaService } from '../prisma/prisma.service';

type RuleRow = Prisma.NotificationRuleGetPayload<{
  include: {
    template: true;
    ruleChannels: { include: { channel: true } };
  };
}>;

/**
 * Prisma-backed NotificationPushStore for the worker (issue: push rules) -
 * the same structural adapter as apps/api's, over the worker's own Prisma
 * client. The two processes share the DB, so a SCHEDULED push created by one
 * is visible to the other; the partial unique index
 * uq_push_log_scheduled_dedup (created in the shared migration) is the
 * cross-process race backstop.
 */
@Injectable()
export class WorkerNotificationPushStore implements NotificationPushStore {
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
