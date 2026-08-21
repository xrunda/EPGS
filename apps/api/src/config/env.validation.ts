import * as Joi from 'joi';

/**
 * Schema for required/optional environment variables for apps/api.
 *
 * Validation runs at startup (see AppModule's ConfigModule.forRoot).
 * On failure, Nest throws before the app boots — this is our "fail fast"
 * mechanism. The resulting error message comes from Joi and only names
 * which keys are missing/invalid, never their values, so secrets are
 * never leaked in logs.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  TZ: Joi.string().default('Asia/Shanghai'),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'log', 'debug', 'verbose').default('log'),

  // Required: the app must fail fast if this is missing. No default on
  // purpose - a missing DATABASE_URL should never silently fall back.
  DATABASE_URL: Joi.string()
    .uri({ scheme: [/postgres(ql)?/] })
    .required(),

  // Issue #6: used only to compute GET /api/system/sync-status health
  // staleness thresholds - see configuration.ts's AppConfig.syncIntervalMinutes doc.
  SYNC_INTERVAL_MINUTES: Joi.number().integer().min(1).max(5).default(3),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_SECONDS: Joi.number().integer().min(300).max(86400).default(28800),
  WEB_ORIGIN: Joi.string()
    .uri({ scheme: [/https?/] })
    .default('http://localhost:5173'),
});
