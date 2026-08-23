import { MockAgent, fetch as undiciFetch, Interceptable } from 'undici';
import { NotificationMsgType } from '@prisma/client';
import {
  WecomWebhookError,
  WecomWebhookSender,
  WecomOutboundMessage,
  toWecomPayload,
} from './wecom-webhook-sender';

/**
 * Mock HTTP server for WecomWebhookSender, mirroring the #20/#6 pattern from
 * apps/worker's http-pacs-ris-adapter.spec.ts: undici's built-in MockAgent
 * injected through the sender's `fetchImpl` option (bound with
 * `{ dispatcher: mockAgent }`), because nock does not intercept Node's native
 * fetch dispatcher and setGlobalDispatcher does not affect globalThis.fetch
 * under this repo's Jest + ts-jest setup.
 */
const ORIGIN = 'https://qyapi.weixin.qq.com';
const WEBHOOK_PATH = '/cgi-bin/webhook/send?key=test-key-123';
const WEBHOOK_URL = `${ORIGIN}${WEBHOOK_PATH}`;

let mockAgent: MockAgent;
let pool: Interceptable;

function mockFetch(): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(input as string, { ...init, dispatcher: mockAgent } as never)) as unknown as typeof fetch;
}

function textMessage(overrides: Partial<WecomOutboundMessage> = {}): WecomOutboundMessage {
  return {
    msgType: NotificationMsgType.TEXT,
    renderedTitle: '',
    renderedContent: '{{reportDate}} 红色关注 3 例',
    coverImageUrl: null,
    linkUrl: null,
    ...overrides,
  };
}

function newsMessage(overrides: Partial<WecomOutboundMessage> = {}): WecomOutboundMessage {
  return {
    msgType: NotificationMsgType.NEWS,
    renderedTitle: '红色预警',
    renderedContent: '今日红色关注 3 例，请及时处理。',
    coverImageUrl: 'https://cdn.example.com/banner.png',
    linkUrl: 'https://workbench.example.com/monitor',
    ...overrides,
  };
}

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  pool = mockAgent.get(ORIGIN);
});
afterEach(async () => {
  await mockAgent.close();
});

describe('toWecomPayload', () => {
  it('maps TEXT to the markdown shape (design §6)', () => {
    expect(toWecomPayload(textMessage())).toEqual({
      msgtype: 'markdown',
      markdown: { content: '{{reportDate}} 红色关注 3 例' },
    });
  });

  it('maps NEWS to the news shape with title/description/url/picurl', () => {
    expect(toWecomPayload(newsMessage())).toEqual({
      msgtype: 'news',
      news: {
        articles: [
          {
            title: '红色预警',
            description: '今日红色关注 3 例，请及时处理。',
            url: 'https://workbench.example.com/monitor',
            picurl: 'https://cdn.example.com/banner.png',
          },
        ],
      },
    });
  });

  it('defaults NEWS url/picurl to empty strings when absent', () => {
    expect(
      toWecomPayload(newsMessage({ linkUrl: null, coverImageUrl: null })),
    ).toEqual({
      msgtype: 'news',
      news: {
        articles: [{ title: '红色预警', description: '今日红色关注 3 例，请及时处理。', url: '', picurl: '' }],
      },
    });
  });
});

describe('WecomWebhookSender.send', () => {
  it('POSTs a TEXT message to the webhook URL and resolves the envelope on errcode 0', async () => {
    pool.intercept({
      path: WEBHOOK_PATH,
      method: 'POST',
      body: JSON.stringify(toWecomPayload(textMessage())),
    }).reply(200, { errcode: 0, errmsg: 'ok' });

    const sender = new WecomWebhookSender({ fetchImpl: mockFetch() });
    await expect(sender.send(WEBHOOK_URL, textMessage())).resolves.toEqual({ errcode: 0, errmsg: 'ok' });
  });

  it('POSTs a NEWS message with the news payload', async () => {
    pool.intercept({
      path: WEBHOOK_PATH,
      method: 'POST',
      body: JSON.stringify(toWecomPayload(newsMessage())),
    }).reply(200, { errcode: 0, errmsg: 'ok' });

    const sender = new WecomWebhookSender({ fetchImpl: mockFetch() });
    await expect(sender.send(WEBHOOK_URL, newsMessage())).resolves.toEqual({ errcode: 0, errmsg: 'ok' });
  });

  it('throws WecomWebhookError carrying errcode/errmsg when WeCom rejects the message', async () => {
    pool.intercept({ path: WEBHOOK_PATH, method: 'POST' }).reply(200, { errcode: 93000, errmsg: 'invalid webhook key' });

    const sender = new WecomWebhookSender({ fetchImpl: mockFetch() });
    await expect(sender.send(WEBHOOK_URL, textMessage())).rejects.toMatchObject({
      name: 'WecomWebhookError',
      wecomErrCode: 93000,
      wecomErrMsg: 'invalid webhook key',
    });
  });

  it('throws with httpStatus for a non-2xx response and never leaks the URL/key', async () => {
    pool.intercept({ path: WEBHOOK_PATH, method: 'POST' }).reply(500, 'boom');

    const sender = new WecomWebhookSender({ fetchImpl: mockFetch() });
    const error = await sender.send(WEBHOOK_URL, textMessage()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WecomWebhookError);
    expect((error as WecomWebhookError).httpStatus).toBe(500);
    expect((error as Error).message).not.toContain('test-key-123');
    expect((error as Error).message).not.toContain('qyapi.weixin.qq.com');
  });

  it('throws for a non-JSON response body', async () => {
    pool.intercept({ path: WEBHOOK_PATH, method: 'POST' }).reply(200, 'definitely not json');

    const sender = new WecomWebhookSender({ fetchImpl: mockFetch() });
    await expect(sender.send(WEBHOOK_URL, textMessage())).rejects.toMatchObject({
      name: 'WecomWebhookError',
      wecomErrMsg: expect.stringContaining('non-JSON'),
    });
  });

  it('throws for an unexpected response shape (no numeric errcode)', async () => {
    pool.intercept({ path: WEBHOOK_PATH, method: 'POST' }).reply(200, { hello: 'world' });

    const sender = new WecomWebhookSender({ fetchImpl: mockFetch() });
    await expect(sender.send(WEBHOOK_URL, textMessage())).rejects.toMatchObject({
      wecomErrMsg: expect.stringContaining('unexpected response shape'),
    });
  });

  it('aborts and throws when the webhook exceeds the timeout', async () => {
    pool.intercept({ path: WEBHOOK_PATH, method: 'POST' }).reply(200, { errcode: 0, errmsg: 'ok' }).delay(500);

    const sender = new WecomWebhookSender({ fetchImpl: mockFetch(), timeoutMs: 50 });
    const error = await sender.send(WEBHOOK_URL, textMessage()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WecomWebhookError);
    expect((error as Error).message).toContain('timeout');
    expect((error as Error).message).not.toContain('test-key-123');
  });
});
