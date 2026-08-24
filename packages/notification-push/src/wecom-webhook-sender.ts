import { Injectable, Logger } from '@nestjs/common';
import { PushMsgType } from './types';

/**
 * Moved VERBATIM from apps/api (issue: push rules) - only the message-shape
 * enum import changed (PushMsgType instead of @prisma/client's
 * NotificationMsgType) so the package stays DB-agnostic. The api test-send
 * and the worker scheduler share this single implementation.
 */

/** Default per-request timeout when no timeoutMs is supplied. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Options for constructing WecomWebhookSender. */
export interface WecomWebhookSenderOptions {
  /** Per-request timeout in ms. Defaults to 10000. */
  timeoutMs?: number;
  /** Injectable fetch implementation, for testing. Defaults to global fetch (Node 24 native). */
  fetchImpl?: typeof fetch;
}

/**
 * Rendered message handed to the sender. `msgType` picks the WeCom payload
 * shape (design §6):
 *   TEXT -> { msgtype: 'text', text: { content } }
 *   NEWS -> { msgtype: 'news', news: { articles: [{ title, description, url, picurl }] } }
 */
export interface WecomOutboundMessage {
  msgType: PushMsgType;
  /** Rendered title; '' for TEXT (ignored by the markdown shape). */
  renderedTitle: string;
  /** Rendered content after {{placeholder}} substitution. */
  renderedContent: string;
  coverImageUrl: string | null;
  linkUrl: string | null;
}

/**
 * Raised for ANY outbound failure: network error, timeout, non-2xx HTTP,
 * non-JSON body, or a WeCom `errcode != 0` in the response. The thrown
 * message and every log line deliberately exclude the webhook URL - it
 * embeds the secret key, and logging it would defeat the point of
 * encrypting it at rest (design §5/§7).
 */
export class WecomWebhookError extends Error {
  constructor(
    public readonly wecomErrCode: number,
    public readonly wecomErrMsg: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(`WeCom webhook send failed (errcode ${wecomErrCode}: ${wecomErrMsg})`);
    this.name = 'WecomWebhookError';
  }
}

/**
 * Minimal WeCom webhook client for the notification module (issue #54).
 * POSTs a message to a WeCom group-bot webhook URL
 * (https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=KEY) and checks the
 * documented response envelope `{ errcode, errmsg }`.
 *
 * The `fetchImpl` constructor option follows the HttpPacsRisAdapter pattern
 * (apps/worker/src/pacs-adapter/) so tests can inject undici's MockAgent
 * without nock/setGlobalDispatcher realm pitfalls.
 */
@Injectable()
export class WecomWebhookSender {
  private readonly logger = new Logger(WecomWebhookSender.name);
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WecomWebhookSenderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Sends `message` to `webhookUrl`. Resolves with the WeCom envelope
   * `{ errcode, errmsg }` on success (errcode == 0); throws
   * WecomWebhookError on any failure. Never logs or throws the URL.
   */
  async send(
    webhookUrl: string,
    message: WecomOutboundMessage,
  ): Promise<{ errcode: number; errmsg: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toWecomPayload(message)),
        signal: controller.signal,
      });
    } catch (error) {
      // Network-level failure / timeout / DNS. Detail names only the failure
      // class (timeout / TypeError / ...) - never the URL. Note: an aborted
      // fetch rejects with a DOMException named 'AbortError' that is NOT
      // instanceof Error in this runtime, so test name directly.
      const name = (error as { name?: string } | null)?.name;
      const detail = name === 'AbortError' ? 'timeout' : error instanceof Error ? error.name : 'network error';
      throw new WecomWebhookError(0, `WeCom webhook request failed: ${detail}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new WecomWebhookError(0, `WeCom webhook returned HTTP ${response.status}`, response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new WecomWebhookError(0, 'WeCom webhook returned a non-JSON response', response.status);
    }

    const errcode = (body as Record<string, unknown> | null)?.errcode;
    if (typeof errcode !== 'number') {
      throw new WecomWebhookError(0, 'WeCom webhook returned an unexpected response shape', response.status);
    }
    const errmsg = typeof (body as Record<string, unknown>).errmsg === 'string'
      ? (body as Record<string, unknown>).errmsg as string
      : '';
    if (errcode !== 0) {
      throw new WecomWebhookError(errcode, errmsg || `errcode ${errcode}`, response.status);
    }
    return { errcode, errmsg };
  }
}

/**
 * Maps a rendered message to the WeCom webhook JSON payload (design §6).
 * TEXT uses `msgtype: 'text'` rather than `markdown`: verified against a
 * live webhook that when a group is bridged into personal WeChat's
 * "企业会话", `markdown` messages render as "暂不支持此消息类型" there while
 * `text` and `news` both render their content correctly (in both the WeCom
 * client and personal WeChat).
 */
export function toWecomPayload(message: WecomOutboundMessage): Record<string, unknown> {
  if (message.msgType === 'TEXT') {
    return { msgtype: 'text', text: { content: message.renderedContent } };
  }
  return {
    msgtype: 'news',
    news: {
      articles: [
        {
          title: message.renderedTitle,
          description: message.renderedContent,
          url: message.linkUrl ?? '',
          picurl: message.coverImageUrl ?? '',
        },
      ],
    },
  };
}
