import { ConfigService } from '@nestjs/config';
import { OpenAiCompatibleChatClient } from '@epgs/ai-semantic';
import {
  buildSemanticModelClient,
  readSemanticModelSettings,
  SEMANTIC_JUDGE_DEPS,
  SemanticModelSettings,
} from './semantic-model.factory';

/**
 * Config -> model client (issue #87).
 *
 * Two properties matter here and neither is about HTTP:
 *
 *  1. A missing setting is REPORTED, never thrown, and the report names the
 *     VARIABLE - never its value. The API key is a credential and this string
 *     ends up in a log line.
 *  2. An unknown api style falls back to the implemented protocol instead of
 *     producing a client that would speak the wrong one. (Joi rejects such a
 *     value at boot anyway; this is the belt to that suspenders, for the paths
 *     that read config without going through validation - the probe CLI.)
 */

/** A ConfigService stand-in: `get(key, default)` over a plain object. */
function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => (values[key] === undefined ? fallback : values[key]),
  } as unknown as ConfigService;
}

const FULL = {
  semanticModelBaseUrl: 'http://10.0.0.5:8000/v1/',
  semanticModelName: 'hospital-model',
};

describe('readSemanticModelSettings', () => {
  it('names every missing variable and returns no settings', () => {
    const { settings, missing } = readSemanticModelSettings(makeConfig({}));

    expect(settings).toBeNull();
    expect(missing).toEqual(['SEMANTIC_MODEL_BASE_URL', 'SEMANTIC_MODEL_NAME']);
  });

  it('treats a blank or whitespace-only value as missing', () => {
    const { settings, missing } = readSemanticModelSettings(
      makeConfig({ semanticModelBaseUrl: '   ', semanticModelName: '' }),
    );

    expect(settings).toBeNull();
    expect(missing).toEqual(['SEMANTIC_MODEL_BASE_URL', 'SEMANTIC_MODEL_NAME']);
  });

  it('reports only the variable that is actually absent', () => {
    const { settings, missing } = readSemanticModelSettings(
      makeConfig({ semanticModelBaseUrl: 'http://gw/v1' }),
    );

    expect(settings).toBeNull();
    expect(missing).toEqual(['SEMANTIC_MODEL_NAME']);
  });

  it('never leaks a value into the missing list', () => {
    // The caller logs `missing.join(', ')`; a value here would put a credential
    // in the log. The API key is set and the URL is not, so only the name of
    // the absent variable may appear.
    const { missing } = readSemanticModelSettings(
      makeConfig({ semanticModelApiKey: 'sk-secret-value', semanticModelName: 'm' }),
    );

    expect(missing).toEqual(['SEMANTIC_MODEL_BASE_URL']);
    expect(missing.join(',')).not.toContain('sk-secret-value');
  });

  it('reads a complete configuration, trimming the values it stores', () => {
    const { settings, missing } = readSemanticModelSettings(
      makeConfig({ ...FULL, semanticModelBaseUrl: '  http://gw/v1  ' }),
    );

    expect(missing).toEqual([]);
    expect(settings).toMatchObject({
      baseUrl: 'http://gw/v1',
      model: 'hospital-model',
      apiStyle: 'openai-chat',
      timeoutMs: 10_000,
      maxTokens: 512,
      contextCharBudget: 400,
    });
  });

  it('omits the api key entirely when it is empty', () => {
    // Not `apiKey: ''` - an empty bearer token is a different request from no
    // Authorization header, and a gateway that rejects the first would look
    // like a broken gateway.
    const withoutKey = readSemanticModelSettings(makeConfig({ ...FULL }));
    expect(withoutKey.settings).not.toHaveProperty('apiKey');

    const blankKey = readSemanticModelSettings(makeConfig({ ...FULL, semanticModelApiKey: '  ' }));
    expect(blankKey.settings).not.toHaveProperty('apiKey');
  });

  it('keeps a configured api key', () => {
    const { settings } = readSemanticModelSettings(
      makeConfig({ ...FULL, semanticModelApiKey: 'sk-abc' }),
    );

    expect(settings?.apiKey).toBe('sk-abc');
  });

  it('honours explicit tuning values over the defaults', () => {
    const { settings } = readSemanticModelSettings(
      makeConfig({
        ...FULL,
        semanticModelTimeoutMs: 3_000,
        semanticModelMaxTokens: 128,
        semanticContextCharBudget: 1_200,
      }),
    );

    expect(settings).toMatchObject({
      timeoutMs: 3_000,
      maxTokens: 128,
      contextCharBudget: 1_200,
    });
  });

  it.each([[undefined], [''], ['nonsense-style']])(
    'falls back to openai-chat for api style %p',
    (style) => {
      const { settings } = readSemanticModelSettings(
        makeConfig({ ...FULL, semanticModelApiStyle: style }),
      );

      expect(settings?.apiStyle).toBe('openai-chat');
    },
  );
});

describe('buildSemanticModelClient', () => {
  const settings: SemanticModelSettings = {
    baseUrl: 'http://gw/v1',
    model: 'hospital-model',
    apiStyle: 'openai-chat',
    timeoutMs: 10_000,
    maxTokens: 512,
    contextCharBudget: 400,
  };

  it('builds the OpenAI-compatible client', () => {
    expect(buildSemanticModelClient(settings)).toBeInstanceOf(OpenAiCompatibleChatClient);
  });

  it('forwards the api key when there is one', () => {
    const client = buildSemanticModelClient({ ...settings, apiKey: 'sk-abc' }) as unknown as {
      apiKey: string;
    };

    expect(client.apiKey).toBe('sk-abc');
  });

  it('builds a keyless client when there is not', () => {
    const client = buildSemanticModelClient(settings) as unknown as { apiKey: string };

    expect(client.apiKey).toBe('');
  });
});

describe('SEMANTIC_JUDGE_DEPS', () => {
  it('is a symbol, so no string token can collide with it', () => {
    // The service is decorated with this token at class-definition time; if it
    // were ever hoisted next to its consumer the decorator would read
    // `undefined` and Nest would silently fail to inject. Keeping it a symbol
    // in a leaf module is what makes that impossible.
    expect(typeof SEMANTIC_JUDGE_DEPS).toBe('symbol');
  });
});
