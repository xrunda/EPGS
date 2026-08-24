import {
  formatShanghaiDate,
  NotificationChannelDisabledError,
  NotificationChannelNotFoundError,
  NotificationPushService,
  NotificationTemplateDisabledError,
  NotificationTemplateNotFoundError,
  WecomWebhookError,
} from '@epgs/notification-push';
import { NotificationTestSendService } from './notification-test-send.service';
import { NotificationChannelNotFoundException } from './errors/notification-channel-not-found.exception';
import { NotificationTemplateNotFoundException } from './errors/notification-template-not-found.exception';
import { NotificationChannelDisabledException } from './errors/notification-channel-disabled.exception';
import { NotificationTemplateDisabledException } from './errors/notification-template-disabled.exception';
import { NotificationSendException } from './errors/notification-send.exception';

/**
 * Unit tests for the test-send service's delegation + error mapping. The
 * shared NotificationPushService pipeline (render → decrypt → send) is fully
 * covered by @epgs/notification-push's own specs; this spec only asserts that
 * (a) the api forwards channel/template/scope exactly, and (b) the shared
 * package's framework-agnostic domain errors translate back to the api's
 * existing Nest exceptions with unchanged status codes.
 */
describe('NotificationTestSendService', () => {
  let push: any;
  let service: NotificationTestSendService;

  beforeEach(() => {
    push = {
      pushToChannel: jest.fn(async () => ({
        success: true,
        renderedTitle: '',
        renderedContent: '内容',
        sentAt: '2026-08-23T01:00:00.000Z',
      })),
    };
    service = new NotificationTestSendService(push as NotificationPushService);
  });

  describe('send', () => {
    it('delegates to the shared pipeline with today (Shanghai) as both the report date and the window date', async () => {
      const result = await service.send('channel-1', 'template-1', ['骨科']);

      expect(push.pushToChannel).toHaveBeenCalledWith({
        channelId: 'channel-1',
        templateId: 'template-1',
        date: formatShanghaiDate(new Date()),
        windowDate: formatShanghaiDate(new Date()),
        scope: ['骨科'],
      });
      expect(result).toEqual({
        success: true,
        renderedTitle: '',
        renderedContent: '内容',
        sentAt: '2026-08-23T01:00:00.000Z',
      });
    });

    it('passes scope through as undefined when no department scope is given (global)', async () => {
      await service.send('channel-1', 'template-1');
      expect(push.pushToChannel).toHaveBeenCalledWith(
        expect.objectContaining({ scope: undefined }),
      );
    });

    it('maps NotificationChannelNotFoundError to the 404 exception', async () => {
      push.pushToChannel.mockRejectedValueOnce(new NotificationChannelNotFoundError('channel-1'));
      await expect(service.send('channel-1', 'template-1')).rejects.toBeInstanceOf(
        NotificationChannelNotFoundException,
      );
    });

    it('maps NotificationChannelDisabledError to the 400 exception', async () => {
      push.pushToChannel.mockRejectedValueOnce(new NotificationChannelDisabledError('channel-1'));
      await expect(service.send('channel-1', 'template-1')).rejects.toBeInstanceOf(
        NotificationChannelDisabledException,
      );
    });

    it('maps NotificationTemplateNotFoundError to the 404 exception', async () => {
      push.pushToChannel.mockRejectedValueOnce(new NotificationTemplateNotFoundError('template-1'));
      await expect(service.send('channel-1', 'template-1')).rejects.toBeInstanceOf(
        NotificationTemplateNotFoundException,
      );
    });

    it('maps NotificationTemplateDisabledError to the 400 exception', async () => {
      push.pushToChannel.mockRejectedValueOnce(new NotificationTemplateDisabledError('template-1'));
      await expect(service.send('channel-1', 'template-1')).rejects.toBeInstanceOf(
        NotificationTemplateDisabledException,
      );
    });

    it('maps a WeCom rejection to NotificationSendException with errcode/errmsg details', async () => {
      push.pushToChannel.mockRejectedValueOnce(new WecomWebhookError(93000, 'invalid webhook key', 200));
      await expect(service.send('channel-1', 'template-1')).rejects.toMatchObject({
        response: {
          code: 'NOTIFICATION_SEND_FAILED',
          details: { wecomErrCode: 93000, wecomErrMsg: 'invalid webhook key' },
        },
      });
    });

    it('rethrows unexpected errors untouched', async () => {
      const boom = new Error('boom');
      push.pushToChannel.mockRejectedValueOnce(boom);
      await expect(service.send('channel-1', 'template-1')).rejects.toBe(boom);
    });
  });
});
