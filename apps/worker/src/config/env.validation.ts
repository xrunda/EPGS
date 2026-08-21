import * as Joi from 'joi';

/**
 * Schema for required/optional environment variables for apps/worker.
 *
 * Mirrors apps/api's validation pattern (see apps/api/src/config/env.validation.ts)
 * so both services fail fast the same way. SYNC_INTERVAL_MINUTES is
 * worker-specific: it governs the placeholder scheduled job's cadence.
 * Real sync logic lands in issue #6 - for now the job just logs a tick.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3001),
  TZ: Joi.string().default('Asia/Shanghai'),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'log', 'debug', 'verbose').default('log'),
  SYNC_INTERVAL_MINUTES: Joi.number().integer().min(1).default(15),

  DATABASE_URL: Joi.string()
    .uri({ scheme: [/postgres(ql)?/] })
    .required(),
});
