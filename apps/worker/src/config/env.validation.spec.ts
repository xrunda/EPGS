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
