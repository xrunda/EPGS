import { OpenAiCompatibleChatClient } from './openai-compatible-chat-client';
import { SemanticError } from './errors';
import type { SemanticModelRequest } from './model-client';

/**
 * The HTTP client, exercised through an injected `fetch` (the same seam
 * WecomWebhookSender uses). No network, no gateway, no undici mock agent
 * needed - the client is the only thing under test.
 */

const REQUEST: SemanticModelRequest = {
  system: 'system prompt',
  user: 'user prompt',
  model: 'hospital-model',
  temperature: 0,
  maxTokens: 512,
  timeoutMs: 5_000,
};

/** A fetch double that records the call and returns a canned response. */
function fakeFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: () =>
        response.jsonBody === undefined
          ? Promise.reject(new Error('not json'))
          : Promise.resolve(response.jsonBody),
      text: () => Promise.resolve(response.textBody ?? ''),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function chatBody(content: string, model = 'hospital-model-v2'): unknown {
  return { choices: [{ message: { role: 'assistant', content } }], model };
}

describe('OpenAiCompatibleChatClient', () => {
  it('posts to <baseUrl>/chat/completions and returns the message content', async () => {
    const { impl, calls } = fakeFetch({ jsonBody: chatBody('{"matched":true}') });
    const client = new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local:8000/v1',
      fetchImpl: impl,
    });

    const result = await client.complete(REQUEST);

    expect(calls[0].url).toBe('http://gw.local:8000/v1/chat/completions');
    expect(result.raw).toBe('{"matched":true}');
    expect(result.modelVersion).toBe('hospital-model-v2');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('tolerates a trailing slash on the base url', async () => {
    const { impl, calls } = fakeFetch({ jsonBody: chatBody('{}') });
    const client = new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1/',
      fetchImpl: impl,
    });

    await client.complete(REQUEST);

    expect(calls[0].url).toBe('http://gw.local/v1/chat/completions');
  });

  it('sends the model, messages and temperature the request describes', async () => {
    const { impl, calls } = fakeFetch({ jsonBody: chatBody('{}') });
    const client = new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1',
      fetchImpl: impl,
    });

    await client.complete(REQUEST);

    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.model).toBe('hospital-model');
    expect(sent.temperature).toBe(0);
    expect(sent.max_tokens).toBe(512);
    expect(sent.stream).toBe(false);
    expect(sent.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ]);
  });

  it('does not ask for response_format, which some gateways reject outright', async () => {
    const { impl, calls } = fakeFetch({ jsonBody: chatBody('{}') });
    const client = new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1',
      fetchImpl: impl,
    });

    await client.complete(REQUEST);

    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty('response_format');
  });

  it('sends an Authorization header only when a key is configured', async () => {
    const withKey = fakeFetch({ jsonBody: chatBody('{}') });
    await new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1',
      apiKey: 'secret-token',
      fetchImpl: withKey.impl,
    }).complete(REQUEST);
    const headers = withKey.calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-token');

    const withoutKey = fakeFetch({ jsonBody: chatBody('{}') });
    await new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1',
      fetchImpl: withoutKey.impl,
    }).complete(REQUEST);
    // Not "Bearer " with nothing after it - some gateways 401 on that with a
    // confusing error.
    expect(withoutKey.calls[0].init.headers as Record<string, string>).not.toHaveProperty(
      'authorization',
    );
  });

  it.each([
    [400, 'HTTP_400'],
    [401, 'HTTP_401'],
    [503, 'HTTP_503'],
  ])('classifies a %i response as %s', async (status, expected) => {
    const { impl } = fakeFetch({ ok: false, status, textBody: 'gateway exploded' });
    const client = new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1',
      fetchImpl: impl,
    });

    await expect(client.complete(REQUEST)).rejects.toMatchObject({
      name: 'SemanticError',
      code: expected,
    });
  });

  it('never puts the error body in the thrown message', async () => {
    // The body is untrusted text that may echo the report back; only the
    // status is allowed to escape.
    const { impl } = fakeFetch({ ok: false, status: 500, textBody: '胃窦见巨大溃疡 patient 张三' });
    const client = new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1',
      fetchImpl: impl,
    });

    await expect(client.complete(REQUEST)).rejects.toThrow(/HTTP 500/);
    await client.complete(REQUEST).catch((err: Error) => {
      expect(err.message).not.toContain('溃疡');
      expect(err.message).not.toContain('张三');
    });
  });

  it('classifies an abort as TIMEOUT', async () => {
    const impl = (() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1',
      fetchImpl: impl,
    });

    await expect(client.complete(REQUEST)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('classifies a transport failure as NETWORK', async () => {
    const impl = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    const client = new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1',
      fetchImpl: impl,
    });

    await expect(client.complete(REQUEST)).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('classifies a non-JSON body as INVALID_JSON', async () => {
    const { impl } = fakeFetch({ ok: true, jsonBody: undefined });
    const client = new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1',
      fetchImpl: impl,
    });

    await expect(client.complete(REQUEST)).rejects.toMatchObject({ code: 'INVALID_JSON' });
  });

  it.each([
    ['no choices', {}],
    ['empty choices', { choices: [] }],
    ['no message', { choices: [{}] }],
    ['non-string content', { choices: [{ message: { content: 42 } }] }],
    ['empty content', { choices: [{ message: { content: '' } }] }],
  ])('classifies a well-formed envelope with %s as SCHEMA_INVALID', async (_label, jsonBody) => {
    const { impl } = fakeFetch({ ok: true, jsonBody });
    const client = new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1',
      fetchImpl: impl,
    });

    await expect(client.complete(REQUEST)).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  });

  it('reports a null model version when the gateway omits one', async () => {
    const { impl } = fakeFetch({
      ok: true,
      jsonBody: { choices: [{ message: { content: '{}' } }] },
    });
    const client = new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1',
      fetchImpl: impl,
    });

    expect((await client.complete(REQUEST)).modelVersion).toBeNull();
  });

  it('does not parse the content - that is the task layer’s job', async () => {
    const { impl } = fakeFetch({ ok: true, jsonBody: chatBody('not json at all') });
    const client = new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1',
      fetchImpl: impl,
    });

    // Returned as-is; validate-match.ts is where it becomes INVALID_JSON.
    expect((await client.complete(REQUEST)).raw).toBe('not json at all');
  });

  it('is a SemanticError, so callers classify without parsing messages', async () => {
    const { impl } = fakeFetch({ ok: false, status: 502 });
    const client = new OpenAiCompatibleChatClient({
      baseUrl: 'http://gw.local/v1',
      fetchImpl: impl,
    });

    await expect(client.complete(REQUEST)).rejects.toBeInstanceOf(SemanticError);
  });
});
