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

  // Issue #54: display name substituted for {{hospitalName}} in notification
  // template rendering (see configuration.ts AppConfig.hospitalName doc).
  // Optional with a sensible default - a deployment that runs the notification
  // module for a different hospital should set it, but the app must never fail
  // to boot over an absent branding value.
  HOSPITAL_NAME: Joi.string().default('菏泽市中医医院'),

  // Issue #53: encryption key for NotificationChannel.webhookUrlCiphertext -
  // the first reversible secret this schema stores. Required, no default,
  // same fail-fast rationale as JWT_SECRET/DATABASE_URL above - encrypting
  // webhook URLs with an implicit/empty key would be worse than refusing to
  // start. Minimum length mirrors JWT_SECRET; NotificationSecretCipher
  // derives a fixed 32-byte AES key from this value via SHA-256, so it does
  // not need to be exactly 32 bytes itself.
  NOTIFICATION_SECRET_KEY: Joi.string().min(32).required(),

  // Push assistant (issue #70). The worker publishes its liveness through the
  // assistant_heartbeat row (the api cannot probe the worker process behind
  // the 网闸). ASSISTANT_STALE_SECONDS is how old that row's lastSeenAt may
  // get before the assistant is judged 失联 - default 90 = 3× the worker's
  // ASSISTANT_HEARTBEAT_SECONDS (30), so one dropped heartbeat is tolerated.
  // Keep it operationally in sync with the worker value; a mismatch only
  // shifts how quickly 失联 is declared, not correctness.
  ASSISTANT_STALE_SECONDS: Joi.number().integer().min(60).max(300).default(90),
});
