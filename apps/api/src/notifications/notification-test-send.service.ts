import { Injectable } from '@nestjs/common';
import { TestSendResult } from '@epgs/shared-types';
import {
  formatShanghaiDate,
  NotificationChannelDisabledError,
  NotificationChannelNotFoundError,
  NotificationPushService,
  NotificationTemplateDisabledError,
  NotificationTemplateNotFoundError,
  WecomWebhookError,
} from '@epgs/notification-push';
import { NotificationChannelNotFoundException } from './errors/notification-channel-not-found.exception';
import { NotificationTemplateNotFoundException } from './errors/notification-template-not-found.exception';
import { NotificationChannelDisabledException } from './errors/notification-channel-disabled.exception';
import { NotificationTemplateDisabledException } from './errors/notification-template-disabled.exception';
import { NotificationSendException } from './errors/notification-send.exception';

/**
 * Renders and pushes one notification to a WeCom webhook for the config UI's
 * "test send" button (issue #54, design §4/§5/§6).
 *
 * Since issue: push rules, this is a thin api-side wrapper over the shared
 * NotificationPushService pipeline - the SAME pipeline a scheduled rule run
 * uses - so a test message is byte-for-byte what a real push would produce.
 * The only behavioral contract change-free mapping done here: translate the
 * shared package's framework-agnostic domain errors back to the api's
 * existing Nest exceptions (error codes/status codes unchanged), and map the
 * api's `date` (report date) without a `windowDate`, which the shared
 * pipeline interprets as "count the full inventory" - exactly the
 * pre-refactor test-send behavior.
 *
 * SECURITY (design §5/§7): the decrypted webhook URL exists only for the
 * sender call and never appears in logs/exceptions; the rendered body never
 * appears in audit meta (the controller's job - see the controller spec).
 */
@Injectable()
export class NotificationTestSendService {
  constructor(private readonly push: NotificationPushService) {}

  /**
   * @param scope Authorized department names (user.departmentScope); empty =
   *        global scope. Matches MonitorService.summary's contract.
   */
  async send(channelId: string, templateId: string, scope?: string[]): Promise<TestSendResult> {
    try {
      const outcome = await this.push.pushToChannel({
        channelId,
        templateId,
        date: formatShanghaiDate(new Date()),
        scope,
      });
      return {
        success: true,
        renderedTitle: outcome.renderedTitle,
        renderedContent: outcome.renderedContent,
        sentAt: outcome.sentAt,
      };
    } catch (error) {
      this.rethrowAsHttp(error, channelId, templateId);
    }
  }

  private rethrowAsHttp(error: unknown, channelId: string, templateId: string): never {
    if (error instanceof NotificationChannelNotFoundError) {
      throw new NotificationChannelNotFoundException(channelId);
    }
    if (error instanceof NotificationChannelDisabledError) {
      throw new NotificationChannelDisabledException(channelId);
    }
    if (error instanceof NotificationTemplateNotFoundError) {
      throw new NotificationTemplateNotFoundException(templateId);
    }
    if (error instanceof NotificationTemplateDisabledError) {
      throw new NotificationTemplateDisabledException(templateId);
    }
    if (error instanceof WecomWebhookError) {
      throw new NotificationSendException(error.wecomErrCode, error.wecomErrMsg);
    }
    throw error;
  }
}
