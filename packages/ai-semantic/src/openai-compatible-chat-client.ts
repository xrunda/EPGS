import { SemanticError, isAbortError } from './errors';
import type {
  SemanticModelApiStyle,
  SemanticModelClient,
  SemanticModelRequest,
  SemanticModelResponse,
} from './model-client';

/**
 * OpenAI-chat-compatible model client (issue #87).
 *
 * ZERO DEPENDENCIES on purpose: the owner's answer on the gateway was "暂时不
 * 知道医院的自有模型网关是否是 OpenAI 兼容", so pulling in an SDK for a
 * protocol we may not be able to speak would be premature. This posts one
 * JSON body with the platform's own `fetch` (Node 24 native, stated in the
 * repo's engines) and reads one field back. The workaround when the gateway
 * turns out to be different is a sibling class, not a rewrite.
 *
 * WHAT THIS CLASS DELIBERATELY DOES NOT DO: parse or validate the content of
 * the reply. It returns `raw` and stops. Structured-output enforcement lives
 * in validate-match.ts, so there is exactly one definition of what a valid
 * verdict is, and it is testable without HTTP.
 *
 * NOTHING HERE LOGS. Not the request body (it contains the report excerpt),
 * not the response body (it may quote it back). Failures become SemanticErrors
 * carrying a status code, and the caller decides what to record.
 */

/** Options for constructing the client. */
export interface OpenAiCompatibleChatClientOptions {
  /** Gateway base URL, e.g. `http://10.0.0.5:8000/v1`. Trailing slash tolerated. */
  baseUrl: string;
  /**
   * Bearer token. Optional: a self-hosted gateway inside the hospital network
   * may not require one. When empty, no Authorization header is sent at all -
   * sending `Bearer ` with nothing after it makes some gateways 401 with a
   * confusing error.
   */
  apiKey?: string;
  /** Wire protocol. Only `openai-chat` today; stored so logs/audit can name it. */
  apiStyle?: SemanticModelApiStyle;
  /**
   * Injectable fetch, for tests. Mirrors WecomWebhookSender's `fetchImpl`
   * option (packages/notification-push), which exists because the repo's Jest
   * setup cannot intercept global fetch via nock.
   */
  fetchImpl?: typeof fetch;
}

/** The subset of the chat-completions envelope this client reads. */
interface ChatCompletionBody {
  choices?: Array<{ message?: { content?: unknown } }>;
  model?: unknown;
}

/** Cap on how much of an error response we read before giving up on it. */
const MAX_ERROR_BODY_BYTES = 512;

export class OpenAiCompatibleChatClient implements SemanticModelClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  readonly apiStyle: SemanticModelApiStyle;

  constructor(options: OpenAiCompatibleChatClientOptions) {
    const base = options.baseUrl.replace(/\/+$/, '');
    this.endpoint = `${base}/chat/completions`;
    this.apiKey = options.apiKey ?? '';
    this.apiStyle = options.apiStyle ?? 'openai-chat';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: SemanticModelRequest): Promise<SemanticModelResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          // Not sent: `response_format`. A judging task wants JSON, but support
          // for the field varies across self-hosted gateways and a gateway
          // that rejects unknown fields would fail every call. The prompt asks
          // for JSON and the parser enforces it, so this costs nothing.
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new SemanticError('TIMEOUT', `model call exceeded ${request.timeoutMs}ms`);
      }
      throw new SemanticError('NETWORK', 'model call failed before a response was received');
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      // Drain a bounded amount of the body so the socket can be reused, then
      // throw away what we read. The status is the whole diagnostic; the body
      // is untrusted text that may echo the request.
      await discardBounded(response);
      throw new SemanticError(
        `HTTP_${response.status}`,
        `model gateway returned HTTP ${response.status}`,
      );
    }

    let body: ChatCompletionBody;
    try {
      body = (await response.json()) as ChatCompletionBody;
    } catch {
      throw new SemanticError('INVALID_JSON', 'model gateway response was not JSON');
    }

    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      // A well-formed envelope with no usable message. `contents` being an
      // array (some gateways) or absent both land here; the parser layer is
      // where "we got text but it is not a verdict" is decided.
      throw new SemanticError(
        'SCHEMA_INVALID',
        'model gateway response carried no message content',
      );
    }

    return {
      raw: content,
      modelVersion: typeof body?.model === 'string' ? body.model : null,
      latencyMs,
    };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}

/**
 * Read at most MAX_ERROR_BODY_BYTES from a failed response and drop it.
 * Never returned, never logged - purely to release the connection cleanly.
 */
async function discardBounded(response: Response): Promise<void> {
  try {
    const text = await response.text();
    void text.slice(0, MAX_ERROR_BODY_BYTES);
  } catch {
    // A body we cannot read is not worth reporting on: the status already
    // told the caller everything we are willing to record.
  }
}
