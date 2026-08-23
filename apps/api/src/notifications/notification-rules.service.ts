import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PaginatedNotificationRules,
  NotificationRuleDto,
  PaginatedPushLogs,
  RunNotificationRuleResult,
} from '@epgs/shared-types';
import {
  NotificationRuleExecutor,
  NotificationRuleNotFoundError,
} from '@epgs/notification-push';
import { PrismaService } from '../prisma/prisma.service';
import { toPushLogDto, toRuleDto } from './notification-rules.mapper';
import { CreateRuleDto } from './dto/create-rule.dto';
import { UpdateRuleDto } from './dto/update-rule.dto';
import { ListRulesQueryDto } from './dto/list-rules.query.dto';
import { ListPushLogsQueryDto } from './dto/list-push-logs.query.dto';
import { NotificationRuleNotFoundException } from './errors/notification-rule-not-found.exception';

const RULE_INCLUDE = {
  template: true,
  ruleChannels: { include: { channel: true } },
} as const;

/**
 * Push-rule CRUD + manual "run now" (issue: push rules). Authorization lives
 * in the controller (reads open, writes/run require SYSTEM_ADMIN); this
 * service only validates referential integrity (template/channel existence)
 * and delegates execution to the shared NotificationRuleExecutor so a manual
 * run and the worker's scheduled tick produce byte-for-byte identical output.
 */
@Injectable()
export class NotificationRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: NotificationRuleExecutor,
  ) {}

  async listRules(query: ListRulesQueryDto): Promise<PaginatedNotificationRules> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.NotificationRuleWhereInput = {
      ...(query.isEnabled !== undefined ? { isEnabled: query.isEnabled } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.notificationRule.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: RULE_INCLUDE,
      }),
      this.prisma.notificationRule.count({ where }),
    ]);

    return { items: items.map(toRuleDto), total, page, pageSize };
  }

  async getRule(id: string): Promise<NotificationRuleDto> {
    const rule = await this.findRuleOrThrow(id);
    return toRuleDto(rule);
  }

  async createRule(dto: CreateRuleDto, actorUsername?: string): Promise<NotificationRuleDto> {
    const actor = actorUsername ?? dto.actorId ?? 'unknown';
    await this.assertReferences(dto.templateId, dto.channelIds);
    const created = await this.prisma.notificationRule.create({
      data: {
        name: dto.name.trim(),
        cron: dto.cron.trim(),
        templateId: dto.templateId,
        isEnabled: dto.isEnabled ?? true,
        createdBy: actor,
        updatedBy: actor,
        ruleChannels: {
          create: dto.channelIds.map((channelId) => ({ channelId })),
        },
      },
      include: RULE_INCLUDE,
    });
    return toRuleDto(created);
  }

  async updateRule(id: string, dto: UpdateRuleDto, actorUsername?: string): Promise<NotificationRuleDto> {
    const actor = actorUsername ?? dto.actorId ?? 'unknown';
    const existing = await this.findRuleOrThrow(id);

    // Channel bindings are replace-as-a-whole: DELETE then re-CREATE keeps the
    // M:N join consistent and order deterministic even when only one binding
    // changes (channelIds is all-or-nothing in the DTO).
    const data: Prisma.NotificationRuleUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.cron !== undefined ? { cron: dto.cron.trim() } : {}),
      ...(dto.templateId !== undefined ? { templateId: dto.templateId } : {}),
      ...(dto.isEnabled !== undefined ? { isEnabled: dto.isEnabled } : {}),
      updatedBy: actor,
    };

    if (dto.channelIds !== undefined) {
      // Validate against the merged template id (incoming or the stored one).
      await this.assertReferences(dto.templateId ?? existing.templateId, dto.channelIds);
      data.ruleChannels = {
        deleteMany: {},
        create: dto.channelIds.map((channelId) => ({ channelId })),
      };
    } else if (dto.templateId !== undefined) {
      await this.assertTemplateExists(dto.templateId);
    }

    const updated = await this.prisma.notificationRule.update({
      where: { id },
      data,
      include: RULE_INCLUDE,
    });
    return toRuleDto(updated);
  }

  async listPushLogs(ruleId: string, query: ListPushLogsQueryDto): Promise<PaginatedPushLogs> {
    await this.findRuleOrThrow(ruleId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where = { ruleId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.pushLog.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { deliveries: { include: { channel: true }, orderBy: { id: 'asc' } } },
      }),
      this.prisma.pushLog.count({ where }),
    ]);

    return { items: items.map(toPushLogDto), total, page, pageSize };
  }

  /**
   * Manual "run now" - always allowed (user decision #5: idempotency only
   * constrains SCHEDULED runs). `windowDate` defaults to today (Shanghai)
   * inside the executor; `scope` is the caller's department scope (empty =
   * global, matching the summary contract). The executor writes the push_log
   * + deliveries and returns the outcome; NOTIFICATION_RULE_NOT_FOUND is
   * surfaced as a 404.
   */
  async runRule(ruleId: string, windowDate?: string, scope?: string[]): Promise<RunNotificationRuleResult> {
    try {
      const result = await this.executor.execute({ ruleId, trigger: 'MANUAL', windowDate, scope });
      return {
        alreadyPushed: result.alreadyPushed,
        pushLogId: result.pushLogId,
        status: result.status,
        deliveries: result.deliveries.map((delivery) => ({
          id: delivery.id,
          channelId: delivery.channelId,
          channelName: delivery.channelName,
          status: delivery.status,
          wecomErrCode: delivery.wecomErrCode,
          wecomErrMsg: delivery.wecomErrMsg,
          sentAt: delivery.sentAt,
        })),
      };
    } catch (error) {
      if (error instanceof NotificationRuleNotFoundError) {
        throw new NotificationRuleNotFoundException(ruleId);
      }
      throw error;
    }
  }

  // ---- private ---------------------------------------------------------

  private async findRuleOrThrow(id: string): Promise<Prisma.NotificationRuleGetPayload<{ include: typeof RULE_INCLUDE }>> {
    const rule = await this.prisma.notificationRule.findUnique({ where: { id }, include: RULE_INCLUDE });
    if (!rule) throw new NotificationRuleNotFoundException(id);
    return rule;
  }

  private async assertReferences(templateId: string, channelIds: string[]): Promise<void> {
    await this.assertTemplateExists(templateId);
    if (channelIds.length === 0) {
      throw new BadRequestException({
        code: 'NOTIFICATION_RULE_NO_CHANNELS',
        message: 'A notification rule must bind at least one channel.',
      });
    }
    const found = await this.prisma.notificationChannel.findMany({
      where: { id: { in: channelIds } },
      select: { id: true },
    });
    const foundIds = new Set(found.map((channel) => channel.id));
    const missing = channelIds.find((channelId) => !foundIds.has(channelId));
    if (missing) {
      throw new NotFoundException({
        code: 'NOTIFICATION_CHANNEL_NOT_FOUND',
        message: `Notification channel ${missing} was not found.`,
      });
    }
  }

  private async assertTemplateExists(templateId: string): Promise<void> {
    const template = await this.prisma.notificationTemplate.findUnique({
      where: { id: templateId },
      select: { id: true },
    });
    if (!template) {
      throw new NotFoundException({
        code: 'NOTIFICATION_TEMPLATE_NOT_FOUND',
        message: `Notification template ${templateId} was not found.`,
      });
    }
  }
}
