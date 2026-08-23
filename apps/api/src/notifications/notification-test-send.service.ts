import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationMsgType } from '@prisma/client';
import { TestSendResult } from '@epgs/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { MonitorService } from '../monitor/monitor.service';
import { formatShanghaiDateTime } from '../monitor/monitor-time';
import { NotificationSecretCipher } from './notification-secret-cipher.service';
import { WecomWebhookSender, WecomWebhookError } from './wecom-webhook-sender';
import { NotificationChannelNotFoundException } from './errors/notification-channel-not-found.exception';
import { NotificationTemplateNotFoundException } from './errors/notification-template-not-found.exception';
import { NotificationChannelDisabledException } from './errors/notification-channel-disabled.exception';
import { NotificationTemplateDisabledException } from './errors/notification-template-disabled.exception';
import { NotificationSendException } from './errors/notification-send.exception';

/**
 * Renders and pushes one notification to a WeCom webhook for the config UI's
 * "test send" button (issue #54, design §4/§5/§6).
 *
 * The rendered values are computed from LIVE data - MonitorService.summary
 * (the same source the workbench uses, honoring the caller's department
 * scope) plus the current Shanghai report date and HOSPITAL_NAME - so the
 * test message is byte-for-byte what a real scheduled push would produce.
 *
 * SECURITY (design §5/§7): the decrypted webhook URL exists only for the
 * sender call and never appears in logs/exceptions; the rendered body never
 * appears in audit meta (the controller's job - see the controller spec).
 */
@Injectable()
export class NotificationTestSendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: NotificationSecretCipher,
    private readonly monitor: MonitorService,
    private readonly sender: WecomWebhookSender,
    private readonly config: ConfigService,
  ) {}

  /**
   * @param scope Authorized department names (user.departmentScope); empty =
   *        global scope. Matches MonitorService.summary's contract.
   */
  async send(channelId: string, templateId: string, scope?: string[]): Promise<TestSendResult> {
    const channel = await this.prisma.notificationChannel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotificationChannelNotFoundException(channelId);
    if (!channel.isEnabled) throw new NotificationChannelDisabledException(channelId);

    const template = await this.prisma.notificationTemplate.findUnique({ where: { id: templateId } });
    if (!template) throw new NotificationTemplateNotFoundException(templateId);
    if (!template.isEnabled) throw new NotificationTemplateDisabledException(templateId);

    const summary = await this.monitor.summary({}, { scope });
    const variables: Record<string, string> = {
      reportDate: formatShanghaiDateTime(new Date()).date,
      hospitalName: this.config.get<string>('hospitalName') ?? '菏泽市中医医院',
      redCount: String(summary.red),
      yellowCount: String(summary.yellow),
      greenCount: String(summary.green),
      unclassifiedCount: String(summary.unclassified),
      totalCount: String(summary.total),
    };

    const renderedContent = renderTemplate(template.contentTemplate, variables);
    // TEXT never carries a title (service invariant); NEWS always does.
    const renderedTitle =
      template.msgType === NotificationMsgType.NEWS
        ? renderTemplate(template.titleTemplate ?? '', variables)
        : '';

    // Ciphertext decrypt failure (corrupted row / rotated key) is an
    // internal fault and intentionally bubbles as a 500 - but the thrown
    // error carries no ciphertext and no URL.
    const webhookUrl = this.cipher.decrypt(channel.webhookUrlCiphertext);

    try {
      await this.sender.send(webhookUrl, {
        msgType: template.msgType,
        renderedTitle,
        renderedContent,
        coverImageUrl: template.coverImageUrl,
        linkUrl: template.linkUrl,
      });
    } catch (error) {
      // Map any outbound failure (network/timeout/HTTP/errcode != 0) to the
      // 502 contract. The WeCom-level reason travels in `details`; the
      // message never contains the URL or key.
      if (error instanceof WecomWebhookError) {
        throw new NotificationSendException(error.wecomErrCode, error.wecomErrMsg);
      }
      throw error;
    }

    return {
      success: true,
      renderedTitle,
      renderedContent,
      sentAt: new Date().toISOString(),
    };
  }
}

/**
 * Replaces every {{key}} token in `template` using `variables`. Unknown
 * tokens are left verbatim (so a future/typo'd placeholder renders visibly
 * rather than vanishing silently). Pure + exported for unit testing.
 */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (match, key: string) => {
    const value = variables[key.trim()];
    return value !== undefined ? value : match;
  });
}
