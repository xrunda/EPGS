import * as Joi from 'joi';

/**
 * Schema for required/optional environment variables for apps/worker.
 *
 * Mirrors apps/api's validation pattern (see apps/api/src/config/env.validation.ts)
 * so both services fail fast the same way. SYNC_INTERVAL_MINUTES governs
 * the real incremental sync job (issue #6) - default 3, kept within the
 * issue's required 1-5 minute range.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3001),
  TZ: Joi.string().default('Asia/Shanghai'),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'log', 'debug', 'verbose').default('log'),

  // How often the sync job runs. Issue #6 acceptance criteria: default
  // within 1-5 minutes, configurable via env.
  SYNC_INTERVAL_MINUTES: Joi.number().integer().min(1).max(5).default(3),
  // Page size requested from the PacsRisAdapter per fetchReports() call.
  SYNC_PAGE_SIZE: Joi.number().integer().min(1).max(500).default(200),
  // Look-back window (minutes) re-read on every run in addition to the
  // last cursor, so a source outage that ends mid-window (or clock
  // skew/late-arriving updatedAt writes) cannot silently skip records -
  // upserts are idempotent so re-reading already-synced rows is safe.
  SYNC_LOOKBACK_MINUTES: Joi.number().integer().min(0).max(120).default(10),
  // Max retry attempts for a whole-batch transient failure (adapter
  // throws PacsHttpTransientError / network error) before giving up on
  // this run without advancing the cursor.
  SYNC_MAX_RETRIES: Joi.number().integer().min(0).max(20).default(5),
  // Base delay (ms) for exponential backoff between batch retries.
  SYNC_RETRY_BASE_DELAY_MS: Joi.number().integer().min(1).default(1000),

  DATABASE_URL: Joi.string()
    .uri({ scheme: [/postgres(ql)?/] })
    .required(),

  // Selects the PacsRisAdapter implementation (see src/pacs-adapter).
  // 'fixture' (default) uses synthetic in-memory data - safe for local
  // dev/CI with no real PACS/RIS connection. 'sql' is an unfinished
  // skeleton (issue #2, no live driver wired). 'http' (issue #6) calls
  // the real issue #20 database gateway contract over HTTP.
  PACS_ADAPTER_MODE: Joi.string().valid('fixture', 'sql', 'http').default('fixture'),

  // Optional: only meaningful when PACS_ADAPTER_MODE=sql. Connection
  // details for the dedicated read-only PACS/RIS account. Never
  // hardcode real values - injected via environment/secret manager only.
  PACS_DB_HOST: Joi.string().optional(),
  PACS_DB_PORT: Joi.number().port().optional(),
  PACS_DB_NAME: Joi.string().optional(),
  PACS_DB_USER: Joi.string().optional(),
  PACS_DB_PASSWORD: Joi.string().optional(),

  // Required when PACS_ADAPTER_MODE=http (issue #6, docs/api/pacs-ris-data-api.md).
  // No real test-environment value exists in this repo/CI - only used
  // against a mock HTTP server in tests. Never commit a real value.
  PACS_HTTP_BASE_URL: Joi.string().uri().optional(),
  PACS_HTTP_SERVICE_TOKEN: Joi.string().optional(),
  PACS_HTTP_TIMEOUT_MS: Joi.number().integer().min(1).default(10000),
});
