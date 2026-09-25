import { envValidationSchema } from './env.validation';

const DATABASE_URL = 'postgresql://user:pass@localhost:5432/epgs';

describe('worker environment validation', () => {
  it('requires a CSV path in csv mode', () => {
    const result = envValidationSchema.validate(
      { DATABASE_URL, PACS_ADAPTER_MODE: 'csv' },
      { abortEarly: false },
    );
    expect(result.error?.message).toMatch(/PACS_MOCK_CSV_PATH.*required/);
  });

  it('requires base URL and token in http mode', () => {
    const result = envValidationSchema.validate(
      { DATABASE_URL, PACS_ADAPTER_MODE: 'http' },
      { abortEarly: false },
    );
    expect(result.error?.message).toMatch(/PACS_HTTP_BASE_URL.*required/);
    expect(result.error?.message).toMatch(/PACS_HTTP_SERVICE_TOKEN.*required/);
  });

  it('rejects the removed sql mode and database-source variables', () => {
    const result = envValidationSchema.validate(
      {
        DATABASE_URL,
        PACS_ADAPTER_MODE: 'sql',
        PACS_DB_HOST: 'database.internal',
      },
      { abortEarly: false },
    );
    expect(result.error?.message).toMatch(/PACS_ADAPTER_MODE/);
    expect(result.error?.message).toMatch(/PACS_DB_HOST.*not allowed/);
  });

  it('allows only the REST adapter in production', () => {
    const result = envValidationSchema.validate(
      {
        DATABASE_URL,
        NODE_ENV: 'production',
        PACS_ADAPTER_MODE: 'csv',
        PACS_MOCK_CSV_PATH: 'Doc/moke-data.csv',
      },
      { abortEarly: false },
    );
    expect(result.error?.message).toMatch(/PACS_ADAPTER_MODE.*http/);
  });
});

describe('worker environment validation - AI semantic judge (issue #87)', () => {
  const base = {
    DATABASE_URL,
    NOTIFICATION_SECRET_KEY: 'x'.repeat(32),
    PACS_ADAPTER_MODE: 'csv',
    PACS_MOCK_CSV_PATH: 'Doc/moke-data.csv',
  };

  it('defaults the judge to OFF, and to no model settings at all', () => {
    const { error, value } = envValidationSchema.validate(base);
    expect(error).toBeUndefined();
    expect(value.SEMANTIC_JUDGE_ENABLED).toBe(false);
    expect(value.SEMANTIC_MODEL_BASE_URL).toBeUndefined();
    expect(value.SEMANTIC_MODEL_API_STYLE).toBe('openai-chat');
  });

  it('defaults every tuning knob to the documented value', () => {
    const { value } = envValidationSchema.validate(base);
    expect(value).toMatchObject({
      SEMANTIC_MODEL_TIMEOUT_MS: 10_000,
      SEMANTIC_MODEL_MAX_TOKENS: 512,
      SEMANTIC_CONTEXT_CHAR_BUDGET: 400,
      SEMANTIC_JUDGE_INTERVAL_SECONDS: 30,
      SEMANTIC_JUDGE_BATCH_SIZE: 10,
      SEMANTIC_JUDGE_MAX_ATTEMPTS: 3,
      SEMANTIC_JUDGE_LEASE_SECONDS: 300,
    });
  });

  it('does NOT require the model variables, even with the judge enabled', () => {
    // A deliberate departure from the PACS_* block: this process also runs the
    // sync job, so a missing model URL must disable the judge rather than stop
    // the worker from booting. readSemanticModelSettings() reports the gap.
    const { error, value } = envValidationSchema.validate({
      ...base,
      SEMANTIC_JUDGE_ENABLED: 'true',
    });
    expect(error).toBeUndefined();
    expect(value.SEMANTIC_JUDGE_ENABLED).toBe(true);
    expect(value.SEMANTIC_MODEL_BASE_URL).toBeUndefined();
  });

  it('accepts a full model configuration', () => {
    const { error, value } = envValidationSchema.validate({
      ...base,
      SEMANTIC_JUDGE_ENABLED: 'true',
      SEMANTIC_MODEL_BASE_URL: 'http://10.0.0.5:8000/v1',
      SEMANTIC_MODEL_API_KEY: 'placeholder',
      SEMANTIC_MODEL_NAME: 'hospital-model',
    });
    expect(error).toBeUndefined();
    expect(value.SEMANTIC_MODEL_BASE_URL).toBe('http://10.0.0.5:8000/v1');
  });

  it('rejects an unknown api style rather than silently defaulting', () => {
    // The seam for the hospital's own gateway: a typo must be loud, because the
    // alternative is a judge that quietly speaks the wrong protocol.
    const { error } = envValidationSchema.validate({
      ...base,
      SEMANTIC_MODEL_API_STYLE: 'anthropic-messages',
    });
    expect(error?.message).toMatch(/SEMANTIC_MODEL_API_STYLE/);
  });

  it.each([
    ['SEMANTIC_MODEL_TIMEOUT_MS', 999],
    ['SEMANTIC_MODEL_MAX_TOKENS', 1],
    ['SEMANTIC_CONTEXT_CHAR_BUDGET', 10],
    ['SEMANTIC_JUDGE_INTERVAL_SECONDS', 1],
    ['SEMANTIC_JUDGE_BATCH_SIZE', 0],
    ['SEMANTIC_JUDGE_MAX_ATTEMPTS', 11],
    ['SEMANTIC_JUDGE_LEASE_SECONDS', 5],
  ])('rejects an out-of-range %s', (key, value) => {
    const { error } = envValidationSchema.validate(
      { ...base, [key]: value },
      { abortEarly: false },
    );
    expect(error?.message).toMatch(new RegExp(key));
  });
});

describe('worker environment validation - AI report classifier (issue #88)', () => {
  const base = {
    DATABASE_URL,
    NOTIFICATION_SECRET_KEY: 'x'.repeat(32),
    PACS_ADAPTER_MODE: 'csv',
    PACS_MOCK_CSV_PATH: 'Doc/moke-data.csv',
  };

  it('defaults the classifier to OFF, independently of the judge', () => {
    const { error, value } = envValidationSchema.validate(base);
    expect(error).toBeUndefined();
    expect(value.SEMANTIC_REPORT_ENABLED).toBe(false);
    expect(value.SEMANTIC_JUDGE_ENABLED).toBe(false);
  });

  it('can be switched on while the judge stays off, and the other way round', () => {
    // The two switches are deliberately independent: the judge can REMOVE a
    // keyword hit, the classifier can only ADD a finding, and a hospital may
    // well want to roll one out months before the other.
    const reportOnly = envValidationSchema.validate({
      ...base,
      SEMANTIC_REPORT_ENABLED: 'true',
    });
    expect(reportOnly.error).toBeUndefined();
    expect(reportOnly.value.SEMANTIC_REPORT_ENABLED).toBe(true);
    expect(reportOnly.value.SEMANTIC_JUDGE_ENABLED).toBe(false);

    const judgeOnly = envValidationSchema.validate({
      ...base,
      SEMANTIC_JUDGE_ENABLED: 'true',
    });
    expect(judgeOnly.error).toBeUndefined();
    expect(judgeOnly.value.SEMANTIC_REPORT_ENABLED).toBe(false);
  });

  it('defaults every tuning knob to the documented value', () => {
    const { value } = envValidationSchema.validate(base);
    expect(value).toMatchObject({
      SEMANTIC_REPORT_TIMEOUT_MS: 20_000,
      SEMANTIC_REPORT_MAX_TOKENS: 1024,
      SEMANTIC_REPORT_MAX_CHARS: 20_000,
      SEMANTIC_REPORT_INTERVAL_SECONDS: 60,
      SEMANTIC_REPORT_BATCH_SIZE: 5,
      SEMANTIC_REPORT_MAX_ATTEMPTS: 3,
      SEMANTIC_REPORT_LEASE_SECONDS: 600,
    });
  });

  it('does NOT require the model variables, even with the classifier enabled', () => {
    // Same reasoning as the judge's block, and the same consequence: a missing
    // model URL disables the classifier with an error log instead of stopping
    // the sync job that feeds patient monitoring.
    const { error, value } = envValidationSchema.validate({
      ...base,
      SEMANTIC_REPORT_ENABLED: 'true',
    });
    expect(error).toBeUndefined();
    expect(value.SEMANTIC_REPORT_ENABLED).toBe(true);
    expect(value.SEMANTIC_MODEL_BASE_URL).toBeUndefined();
  });

  it('shares the judge’s gateway variables rather than defining its own', () => {
    // One hospital, one gateway. If this ever needs its own connection settings
    // the schema will say so; until then the classifier must not accept a
    // second set of them, because two places to configure is two places to get
    // wrong.
    const { error, value } = envValidationSchema.validate({
      ...base,
      SEMANTIC_REPORT_ENABLED: 'true',
      SEMANTIC_MODEL_BASE_URL: 'http://10.0.0.5:8000/v1',
      SEMANTIC_MODEL_NAME: 'hospital-model',
    });
    expect(error).toBeUndefined();
    expect(value.SEMANTIC_MODEL_BASE_URL).toBe('http://10.0.0.5:8000/v1');

    const ownGateway = envValidationSchema.validate({
      ...base,
      SEMANTIC_REPORT_MODEL_BASE_URL: 'http://10.0.0.5:8000/v1',
    });
    expect(ownGateway.error?.message).toMatch(/SEMANTIC_REPORT_MODEL_BASE_URL.*not allowed/);
  });

  it.each([
    ['SEMANTIC_REPORT_TIMEOUT_MS', 999],
    ['SEMANTIC_REPORT_MAX_TOKENS', 8],
    ['SEMANTIC_REPORT_MAX_CHARS', 100],
    ['SEMANTIC_REPORT_INTERVAL_SECONDS', 1],
    ['SEMANTIC_REPORT_BATCH_SIZE', 0],
    ['SEMANTIC_REPORT_MAX_ATTEMPTS', 11],
    ['SEMANTIC_REPORT_LEASE_SECONDS', 5],
  ])('rejects an out-of-range %s', (key, value) => {
    const { error } = envValidationSchema.validate(
      { ...base, [key]: value },
      { abortEarly: false },
    );
    expect(error?.message).toMatch(new RegExp(key));
  });
});
