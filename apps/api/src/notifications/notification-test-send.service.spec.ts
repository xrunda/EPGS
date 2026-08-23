import { NotificationTestSendService, renderTemplate } from './notification-test-send.service';
import { WecomWebhookError } from './wecom-webhook-sender';
import { NotificationChannelNotFoundException } from './errors/notification-channel-not-found.exception';
import { NotificationTemplateNotFoundException } from './errors/notification-template-not-found.exception';
import { NotificationChannelDisabledException } from './errors/notification-channel-disabled.exception';
import { NotificationTemplateDisabledException } from './errors/notification-template-disabled.exception';
import { formatShanghaiDateTime } from '../monitor/monitor-time';

/**
 * Unit tests against mocked Prisma / MonitorService / cipher / sender - no
 * real database, summary, crypto, or outbound HTTP. Covers the render →
 * decrypt → send pipeline in isolation; the real-DB e2e suite exercises the
 * same flow end-to-end.
 */
describe('NotificationTestSendService', () => {
  let prisma: any;
  let cipher: any;
  let monitor: any;
  let sender: any;
  let config: any;
  let service: NotificationTestSendService;
  let channelStore: Map<string, any>;
  let templateStore: Map<string, any>;

  function makeChannel(overrides: Record<string, any> = {}): any {
    const id = overrides.id ?? 'channel-1';
    const channel = {
      id,
      webhookUrlCiphertext: 'enc:https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key',
      isEnabled: true,
      ...overrides,
    };
    channelStore.set(id, channel);
    return channel;
  }

  function makeTemplate(overrides: Record<string, any> = {}): any {
    const id = overrides.id ?? 'template-1';
    const template = {
      id,
      msgType: 'TEXT',
      titleTemplate: null,
      contentTemplate: '{{reportDate}} {{hospitalName}} 红色关注 {{redCount}} 例',
      coverImageUrl: null,
      linkUrl: null,
      isEnabled: true,
      ...overrides,
    };
    templateStore.set(id, template);
    return template;
  }

  beforeEach(() => {
    channelStore = new Map();
    templateStore = new Map();

    prisma = {
      notificationChannel: {
        findUnique: jest.fn(async ({ where: { id } }: any) => channelStore.get(id) ?? null),
      },
      notificationTemplate: {
        findUnique: jest.fn(async ({ where: { id } }: any) => templateStore.get(id) ?? null),
      },
    };
    cipher = {
      decrypt: jest.fn((payload: string) => payload.replace('enc:', '')),
    };
    monitor = {
      summary: jest.fn(async () => ({ total: 22, red: 3, yellow: 5, green: 12, unclassified: 2 })),
    };
    sender = {
      send: jest.fn(async () => ({ errcode: 0, errmsg: 'ok' })),
    };
    config = {
      get: jest.fn((key: string) => (key === 'hospitalName' ? '菏泽市中医医院' : undefined)),
    };

    service = new NotificationTestSendService(prisma, cipher, monitor, sender, config);
  });

  describe('renderTemplate', () => {
    it('substitutes known tokens and trims inner whitespace in the key', () => {
      expect(renderTemplate('a{{x}}b{{ y }}c', { x: '1', y: '2' })).toBe('a1b2c');
    });

    it('leaves unknown tokens verbatim', () => {
      expect(renderTemplate('{{unknown}} 保留', {})).toBe('{{unknown}} 保留');
    });
  });

  describe('send', () => {
    it('renders TEXT content from live summary + hospital name and pushes a markdown message', async () => {
      const channel = makeChannel();
      const template = makeTemplate();

      const result = await service.send(channel.id, template.id, ['骨科']);

      expect(monitor.summary).toHaveBeenCalledWith({}, { scope: ['骨科'] });
      expect(cipher.decrypt).toHaveBeenCalledWith(channel.webhookUrlCiphertext);
      expect(sender.send).toHaveBeenCalledWith(
        'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key',
        expect.objectContaining({
          msgType: 'TEXT',
          renderedContent: `${formatShanghaiDateTime(new Date()).date} 菏泽市中医医院 红色关注 3 例`,
          renderedTitle: '',
        }),
      );
      expect(result).toMatchObject({
        success: true,
        renderedTitle: '',
        renderedContent: `${formatShanghaiDateTime(new Date()).date} 菏泽市中医医院 红色关注 3 例`,
      });
      expect(typeof result.sentAt).toBe('string');
    });

    it('renders NEWS title and content, and defaults hospitalName when unconfigured', async () => {
      const channel = makeChannel();
      const template = makeTemplate({
        msgType: 'NEWS',
        titleTemplate: '{{reportDate}} 预警',
        contentTemplate: '共 {{totalCount}} 条，红色 {{redCount}}。',
        coverImageUrl: 'https://cdn.example.com/banner.png',
        linkUrl: 'https://example.com/monitor',
      });
      config.get.mockReturnValue(undefined);

      const result = await service.send(channel.id, template.id);

      expect(result.renderedTitle).toBe(`${formatShanghaiDateTime(new Date()).date} 预警`);
      expect(result.renderedContent).toBe('共 22 条，红色 3。');
      expect(sender.send).toHaveBeenCalledWith(
        expect.stringContaining('secret-key'),
        expect.objectContaining({
          msgType: 'NEWS',
          coverImageUrl: 'https://cdn.example.com/banner.png',
          linkUrl: 'https://example.com/monitor',
        }),
      );
    });

    it('uses global scope when no department scope is given', async () => {
      const channel = makeChannel();
      const template = makeTemplate();
      await service.send(channel.id, template.id);
      expect(monitor.summary).toHaveBeenCalledWith({}, { scope: undefined });
    });

    it('throws 404 when the channel does not exist', async () => {
      const template = makeTemplate();
      await expect(service.send('missing', template.id)).rejects.toBeInstanceOf(
        NotificationChannelNotFoundException,
      );
    });

    it('throws 400 when the channel is disabled', async () => {
      const channel = makeChannel({ isEnabled: false });
      const template = makeTemplate();
      await expect(service.send(channel.id, template.id)).rejects.toBeInstanceOf(
        NotificationChannelDisabledException,
      );
    });

    it('throws 404 when the template does not exist', async () => {
      const channel = makeChannel();
      await expect(service.send(channel.id, 'missing')).rejects.toBeInstanceOf(
        NotificationTemplateNotFoundException,
      );
    });

    it('throws 400 when the template is disabled', async () => {
      const channel = makeChannel();
      const template = makeTemplate({ isEnabled: false });
      await expect(service.send(channel.id, template.id)).rejects.toBeInstanceOf(
        NotificationTemplateDisabledException,
      );
    });

    it('maps a WeCom rejection to NotificationSendException with errcode/errmsg details', async () => {
      const channel = makeChannel();
      const template = makeTemplate();
      sender.send.mockRejectedValueOnce(new WecomWebhookError(93000, 'invalid webhook key', 200));

      await expect(service.send(channel.id, template.id)).rejects.toMatchObject({
        response: {
          code: 'NOTIFICATION_SEND_FAILED',
          details: { wecomErrCode: 93000, wecomErrMsg: 'invalid webhook key' },
        },
      });
    });

    it('does not push when the channel/template lookup fails (no sender call)', async () => {
      const channel = makeChannel();
      const template = makeTemplate({ isEnabled: false });
      await service.send(channel.id, template.id).catch(() => undefined);
      expect(sender.send).not.toHaveBeenCalled();
    });
  });
});
