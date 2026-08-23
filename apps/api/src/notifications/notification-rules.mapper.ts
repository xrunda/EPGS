import { Prisma } from '@prisma/client';
import {
  NotificationRuleChannelDto,
  NotificationRuleDto,
  PushDeliveryDto,
  PushLogDto,
} from '@epgs/shared-types';

type RuleRow = Prisma.NotificationRuleGetPayload<{
  include: {
    template: true;
    ruleChannels: { include: { channel: true } };
  };
}>;

type PushLogRow = Prisma.PushLogGetPayload<{
  include: { deliveries: { include: { channel: true } } };
}>;

/**
 * Maps Prisma push-rule rows to wire-level DTOs (issue: push rules).
 *
 * Channel bindings are denormalized as `channels: [{ id, channelId, name }]`
 * so the web UI can render the bound-channel names without a second fetch.
 * Template likewise denormalizes `templateName`. Push logs embed their
 * deliveries (each with a denormalized channelName - a channel may be deleted
 * after a run, and the log must still display its name).
 */
export function toRuleDto(rule: RuleRow): NotificationRuleDto {
  return {
    id: rule.id,
    name: rule.name,
    cron: rule.cron,
    templateId: rule.templateId,
    templateName: rule.template?.name ?? '',
    channels: rule.ruleChannels.map((ruleChannel): NotificationRuleChannelDto => ({
      id: ruleChannel.id,
      channelId: ruleChannel.channelId,
      name: ruleChannel.channel?.name ?? '',
    })),
    isEnabled: rule.isEnabled,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    createdBy: rule.createdBy,
    updatedBy: rule.updatedBy,
  };
}

export function toPushLogDto(log: PushLogRow): PushLogDto {
  return {
    id: log.id,
    ruleId: log.ruleId,
    windowDate: log.windowDate,
    trigger: log.trigger,
    status: log.status,
    errorSummary: log.errorSummary,
    startedAt: log.startedAt.toISOString(),
    finishedAt: log.finishedAt?.toISOString() ?? null,
    deliveries: log.deliveries.map((delivery): PushDeliveryDto => ({
      id: delivery.id,
      channelId: delivery.channelId,
      channelName: delivery.channel?.name ?? '',
      status: delivery.status,
      wecomErrCode: delivery.wecomErrCode,
      wecomErrMsg: delivery.wecomErrMsg,
      sentAt: delivery.sentAt?.toISOString() ?? null,
    })),
  };
}
