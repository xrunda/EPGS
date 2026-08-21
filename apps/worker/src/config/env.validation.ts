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
  // First-ever run window (minutes before "now") used only when
  // sync_job_log has no prior SUCCEEDED/PARTIAL run at all - see
  // sync-cursor.ts#resolveCursor. Deliberately independent from (and
  // much larger than) SYNC_LOOKBACK_MINUTES: the look-back window is
  // sized for "how much drift/outage can a HEALTHY steady-state
  // deployment tolerate" (minutes), while the first run needs to catch
  // up on however much backlog exists at go-live (hours-to-days), or a
  // fresh deployment would silently skip everything older than a few
  // minutes on its very first sync. Default 1440 (24h) - override for a
  // larger initial backlog at rollout time.
  SYNC_FIRST_RUN_LOOKBACK_MINUTES: Joi.number().integer().min(1).max(43200).default(1440),
  // Max retry attempts for a whole-batch transient failure (adapter
  // throws PacsHttpTransientError / network error) before giving up on
  // this run without advancing the cursor.
  SYNC_MAX_RETRIES: Joi.number().integer().min(0).max(20).default(5),
  // Base delay (ms) for exponential backoff between batch retries.
  SYNC_RETRY_BASE_DELAY_MS: Joi.number().integer().min(1).default(1000),

  DATABASE_URL: Joi.string()
    .uri({ scheme: [/postgres(ql)?/] })
    .required(),

  // The hospital database gateway is outside this repository. Production
  // uses http or soap depending on what the hospital exposes; local
  // development may read a synthetic API-shaped CSV.
  PACS_ADAPTER_MODE: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().valid('http', 'soap').required(),
    otherwise: Joi.string().valid('csv', 'http', 'soap').default('csv'),
  }),
  PACS_MOCK_CSV_PATH: Joi.string().when('PACS_ADAPTER_MODE', {
    is: 'csv',
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),

  // Required when PACS_ADAPTER_MODE=http (issue #6, docs/api/pacs-ris-data-api.md).
  // No real test-environment value exists in this repo/CI - only used
  // against a mock HTTP server in tests. Never commit a real value.
  PACS_HTTP_BASE_URL: Joi.string().uri().when('PACS_ADAPTER_MODE', {
    is: 'http',
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
  PACS_HTTP_SERVICE_TOKEN: Joi.string().when('PACS_ADAPTER_MODE', {
    is: 'http',
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
  PACS_HTTP_TIMEOUT_MS: Joi.number().integer().min(1).default(10000),

  // Required when PACS_ADAPTER_MODE=soap - the DHC/InterSystems Ensemble
  // EnsWebService gateway confirmed by a live probe (see
  // docs/pacs-ris-adapter.md). No real credentials exist in this
  // repo/CI - never commit a real value.
  PACS_SOAP_BASE_URL: Joi.string().uri().when('PACS_ADAPTER_MODE', {
    is: 'soap',
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
  PACS_SOAP_USERNAME: Joi.string().when('PACS_ADAPTER_MODE', {
    is: 'soap',
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
  PACS_SOAP_PASSWORD: Joi.string().when('PACS_ADAPTER_MODE', {
    is: 'soap',
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
  PACS_SOAP_KEY_NAME: Joi.string().when('PACS_ADAPTER_MODE', {
    is: 'soap',
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
  PACS_SOAP_TIMEOUT_MS: Joi.number().integer().min(1).default(15000),
});
