import { NotificationPushService, PushToChannelInput } from './push.service';
import { NotificationSecretCipher } from './notification-secret-cipher';
import { WecomWebhookError, WecomWebhookSender } from './wecom-webhook-sender';
import { NotificationSummaryProvider } from './summary';
import { NotificationPushStore } from './store';
import {
  NotificationChannelDisabledError,
  NotificationChannelNotFoundError,
  NotificationTemplateDisabledError,
  NotificationTemplateNotFoundError,
} from './errors';
import { PushChannel, PushSummary, PushTemplate } from './types';

function makeChannel(overrides: Partial<PushChannel> = {}): PushChannel {
  return {
    id: 'channel-1',
    name: '总值班室群',
    webhookUrlCiphertext: 'ciphertext-of-url',
    isEnabled: true,
    ...overrides,
  };
}

function makeTemplate(overrides: Partial<PushTemplate> = {}): PushTemplate {
  return {
    id: 'template-1',
    msgType: 'TEXT',
    titleTemplate: null,
    contentTemplate: '{{reportDate}} 共{{totalCount}}例',
    coverImageUrl: null,
    linkUrl: null,
    isEnabled: true,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<PushSummary> = {}): PushSummary {
  return {
    total: 7,
    red: 2,
    yellow: 1,
    green: 3,
    unclassified: 1,
    keywordHits: [],
    ...overrides,
  };
}

function makeDeps() {
  const store = { getChannel: jest.fn(), getTemplate: jest.fn() };
  const cipher = {
    decrypt: jest.fn().mockReturnValue('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=decrypted-key'),
  };
  const sender = { send: jest.fn(async () => ({ errcode: 0, errmsg: 'ok' })) as jest.Mock };
  const summary = { get: jest.fn(async () => makeSummary()) };
  const hospitalNameProvider = jest.fn(() => '菏泽市中医医院');

  const service = new NotificationPushService({
    store: store as unknown as NotificationPushStore,
    cipher: cipher as unknown as NotificationSecretCipher,
    sender: sender as unknown as WecomWebhookSender,
    summary: summary as unknown as NotificationSummaryProvider,
    hospitalNameProvider,
  });
  return { service, store, cipher, sender, summary, hospitalNameProvider };
}

function baseInput(overrides: Partial<PushToChannelInput> = {}): PushToChannelInput {
  return { channelId: 'channel-1', templateId: 'template-1', date: '2026-08-23', ...overrides };
}

describe('NotificationPushService.pushToChannel', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-23T01:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders the template from the summary, decrypts the webhook, and sends', async () => {
    const { service, store, cipher, sender, summary } = makeDeps();
    store.getChannel.mockResolvedValue(makeChannel());
    store.getTemplate.mockResolvedValue(makeTemplate());

    const outcome = await service.pushToChannel(baseInput());

    expect(outcome).toMatchObject({
      success: true,
      renderedTitle: '',
      renderedContent: '2026-08-23 共7例',
      sentAt: expect.any(String),
    });
    expect(summary.get).toHaveBeenCalledWith({ date: undefined, scope: undefined });
    expect(cipher.decrypt).toHaveBeenCalledWith('ciphertext-of-url');
    expect(sender.send).toHaveBeenCalledTimes(1);
    const [url, message] = sender.send.mock.calls[0];
    expect(url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=decrypted-key');
    expect(message).toMatchObject({
      msgType: 'TEXT',
      renderedTitle: '',
      renderedContent: '2026-08-23 共7例',
      coverImageUrl: null,
      linkUrl: null,
    });
  });

  it('renders a NEWS title when the template is NEWS', async () => {
    const { service, store, sender } = makeDeps();
    store.getChannel.mockResolvedValue(makeChannel());
    store.getTemplate.mockResolvedValue(makeTemplate({ msgType: 'NEWS', titleTemplate: '红色 {{redCount}} 例' }));

    await service.pushToChannel(baseInput());

    const message = sender.send.mock.calls[0][1];
    expect(message.msgType).toBe('NEWS');
    expect(message.renderedTitle).toBe('红色 2 例');
  });

  it('passes the full inventory when windowDate is absent (test-send byte-compat)', async () => {
    const { service, store, summary } = makeDeps();
    store.getChannel.mockResolvedValue(makeChannel());
    store.getTemplate.mockResolvedValue(makeTemplate());

    await service.pushToChannel(baseInput());

    expect(summary.get).toHaveBeenCalledWith({ date: undefined, scope: undefined });
  });

  it('passes windowDate + scope through to the summary provider when present', async () => {
    const { service, store, summary } = makeDeps();
    store.getChannel.mockResolvedValue(makeChannel());
    store.getTemplate.mockResolvedValue(makeTemplate());

    await service.pushToChannel(baseInput({ windowDate: '2026-08-22', scope: ['骨科'] }));

    expect(summary.get).toHaveBeenCalledWith({ date: '2026-08-22', scope: ['骨科'] });
  });

  it('throws NotificationChannelNotFoundError for a missing channel', async () => {
    const { service, store, sender } = makeDeps();
    store.getChannel.mockResolvedValue(null);

    await expect(service.pushToChannel(baseInput())).rejects.toBeInstanceOf(NotificationChannelNotFoundError);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('throws NotificationChannelDisabledError for a disabled channel', async () => {
    const { service, store, sender } = makeDeps();
    store.getChannel.mockResolvedValue(makeChannel({ isEnabled: false }));

    await expect(service.pushToChannel(baseInput())).rejects.toBeInstanceOf(NotificationChannelDisabledError);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('throws NotificationTemplateNotFoundError for a missing template', async () => {
    const { service, store, sender } = makeDeps();
    store.getChannel.mockResolvedValue(makeChannel());
    store.getTemplate.mockResolvedValue(null);

    await expect(service.pushToChannel(baseInput())).rejects.toBeInstanceOf(NotificationTemplateNotFoundError);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('throws NotificationTemplateDisabledError for a disabled template', async () => {
    const { service, store, sender } = makeDeps();
    store.getChannel.mockResolvedValue(makeChannel());
    store.getTemplate.mockResolvedValue(makeTemplate({ isEnabled: false }));

    await expect(service.pushToChannel(baseInput())).rejects.toBeInstanceOf(NotificationTemplateDisabledError);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('propagates WecomWebhookError from the sender unchanged', async () => {
    const { service, store, sender } = makeDeps();
    store.getChannel.mockResolvedValue(makeChannel());
    store.getTemplate.mockResolvedValue(makeTemplate());
    sender.send.mockRejectedValueOnce(new WecomWebhookError(93000, 'invalid webhook key'));

    await expect(service.pushToChannel(baseInput())).rejects.toMatchObject({
      name: 'WecomWebhookError',
      wecomErrCode: 93000,
      wecomErrMsg: 'invalid webhook key',
    });
  });

  describe('alert cards (issue #72)', () => {
    const cards = [
      { level: 'RED' as const, count: 2, title: '红色关注 2 例 · 2026-08-23', description: 'd1', url: 'http://h/alert?t=a' },
      { level: 'GREEN' as const, count: 1, title: '绿色关注 1 例 · 2026-08-23', description: 'd2', url: 'http://h/alert?t=b' },
    ];

    it('sends ONE extra news message with one article per card, after the template message', async () => {
      const { service, store, sender } = makeDeps();
      store.getChannel.mockResolvedValue(makeChannel());
      store.getTemplate.mockResolvedValue(makeTemplate());

      const outcome = await service.pushToChannel(baseInput({ alertCards: cards }));

      expect(outcome.success).toBe(true);
      expect(sender.send).toHaveBeenCalledTimes(2);
      expect(sender.send.mock.calls[0][1]).toMatchObject({ msgType: 'TEXT' });
      expect(sender.send.mock.calls[1][0]).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=decrypted-key');
      expect(sender.send.mock.calls[1][1]).toEqual({
        articles: [
          { title: '红色关注 2 例 · 2026-08-23', description: 'd1', url: 'http://h/alert?t=a' },
          { title: '绿色关注 1 例 · 2026-08-23', description: 'd2', url: 'http://h/alert?t=b' },
        ],
      });
    });

    it('sends only the template message when alertCards is absent or empty (test-send stays single-send)', async () => {
      const { service, store, sender } = makeDeps();
      store.getChannel.mockResolvedValue(makeChannel());
      store.getTemplate.mockResolvedValue(makeTemplate());

      await service.pushToChannel(baseInput());
      await service.pushToChannel(baseInput({ alertCards: [] }));

      expect(sender.send).toHaveBeenCalledTimes(2);
      expect(sender.send.mock.calls.every(([, message]) => !('articles' in message))).toBe(true);
    });

    it('surfaces a card failure as a WecomWebhookError that says the body already went out', async () => {
      const { service, store, sender } = makeDeps();
      store.getChannel.mockResolvedValue(makeChannel());
      store.getTemplate.mockResolvedValue(makeTemplate());
      sender.send
        .mockResolvedValueOnce({ errcode: 0, errmsg: 'ok' })
        .mockRejectedValueOnce(new WecomWebhookError(45009, 'api freq out of limit', 200));

      await expect(service.pushToChannel(baseInput({ alertCards: cards }))).rejects.toMatchObject({
        name: 'WecomWebhookError',
        wecomErrCode: 45009,
        wecomErrMsg: '正文已发送，关注卡片发送失败: api freq out of limit',
        httpStatus: 200,
      });
      expect(sender.send).toHaveBeenCalledTimes(2);
    });

    it('does not attempt the cards when the template message itself failed', async () => {
      const { service, store, sender } = makeDeps();
      store.getChannel.mockResolvedValue(makeChannel());
      store.getTemplate.mockResolvedValue(makeTemplate());
      sender.send.mockRejectedValueOnce(new WecomWebhookError(93000, 'invalid webhook key'));

      await expect(service.pushToChannel(baseInput({ alertCards: cards }))).rejects.toMatchObject({
        wecomErrMsg: 'invalid webhook key',
      });
      expect(sender.send).toHaveBeenCalledTimes(1);
    });
  });
});
