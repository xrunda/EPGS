import { NotificationSecretCipher } from './notification-secret-cipher';
import { WecomWebhookSender } from './wecom-webhook-sender';
import { NotificationSummaryProvider } from './summary';
import { NotificationPushStore } from './store';
import { PushDeliveryOutcome } from './types';
import { buildNotificationVariables, renderTemplate } from './render';
import {
  NotificationChannelDisabledError,
  NotificationChannelNotFoundError,
  NotificationTemplateDisabledError,
  NotificationTemplateNotFoundError,
} from './errors';

/**
 * The single-channel push pipeline shared by the api's test-send and the
 * worker's scheduled/manual rule runs (issue: push rules). Moves the body of
 * the pre-refactor NotificationTestSendService.send() here - load channel →
 * load template → summary → build variables → render → decrypt webhook →
 * send - so the manual "run now" produces byte-for-byte the same message as
 * test-send.
 *
 * Domain failures (missing/disabled channel or template) throw the
 * framework-agnostic errors in errors.ts; outbound failures rethrow
 * WecomWebhookError. The api maps these to its existing HTTP contract; the
 * rule executor catches them per-channel and records a FAILED delivery.
 */

export interface NotificationPushServiceDeps {
  store: NotificationPushStore;
  cipher: NotificationSecretCipher;
  sender: WecomWebhookSender;
  summary: NotificationSummaryProvider;
  /** Provides HOSPITAL_NAME (env), e.g. `() => '菏泽市中医医院'`. */
  hospitalNameProvider: () => string;
}

export interface PushToChannelInput {
  channelId: string;
  templateId: string;
  /** Report date displayed in the message (Shanghai YYYY-MM-DD). */
  date: string;
  /**
   * Summary window date. When present the counts are the records whose
   * examTime falls inside that Shanghai day ("今日新报告"); when ABSENT the
   * counts are the full inventory - this is exactly the pre-refactor
   * test-send behavior and is what keeps it byte-for-byte unchanged.
   */
  windowDate?: string;
  /** Department scope (empty = global), matching MonitorService.summary's contract. */
  scope?: string[];
}

export class NotificationPushService {
  constructor(private readonly deps: NotificationPushServiceDeps) {}

  async pushToChannel(input: PushToChannelInput): Promise<PushDeliveryOutcome> {
    const { store, cipher, sender, summary, hospitalNameProvider } = this.deps;

    const channel = await store.getChannel(input.channelId);
    if (!channel) throw new NotificationChannelNotFoundError(input.channelId);
    if (!channel.isEnabled) throw new NotificationChannelDisabledError(input.channelId);

    const template = await store.getTemplate(input.templateId);
    if (!template) throw new NotificationTemplateNotFoundError(input.templateId);
    if (!template.isEnabled) throw new NotificationTemplateDisabledError(input.templateId);

    const counts = await summary.get({ date: input.windowDate, scope: input.scope });
    const variables = buildNotificationVariables(counts, {
      reportDate: input.date,
      hospitalName: hospitalNameProvider(),
    });

    const renderedContent = renderTemplate(template.contentTemplate, variables);
    // TEXT never carries a title (service invariant); NEWS always does.
    const renderedTitle =
      template.msgType === 'NEWS'
        ? renderTemplate(template.titleTemplate ?? '', variables)
        : '';

    // Ciphertext decrypt failure (corrupted row / rotated key) is an
    // internal fault and intentionally bubbles (the api maps it to a 500;
    // the rule executor records the delivery as FAILED) - the thrown error
    // carries no ciphertext and no URL.
    const webhookUrl = cipher.decrypt(channel.webhookUrlCiphertext);

    await sender.send(webhookUrl, {
      msgType: template.msgType,
      renderedTitle,
      renderedContent,
      coverImageUrl: template.coverImageUrl,
      linkUrl: template.linkUrl,
    });

    return {
      success: true,
      renderedTitle,
      renderedContent,
      sentAt: new Date().toISOString(),
    };
  }
}
