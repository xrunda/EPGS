/**
 * Typed accessor shape for config values consumed via ConfigService.
 * Kept intentionally minimal for issue #1 - later issues can extend this.
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  tz: string;
  logLevel: string;
  databaseUrl: string;
  /**
   * Mirrors apps/worker's SYNC_INTERVAL_MINUTES (issue #6). apps/api does
   * not run the sync job itself - it only reads sync_job_log (shared
   * Postgres) to serve GET /api/system/sync-status - but needs the same
   * cadence value to judge "how stale is too stale" (health thresholds
   * are expressed as a multiple of this interval). Keep both apps'
   * env values in sync operationally; a mismatch only affects the
   * accuracy of the health classification, not correctness of the raw
   * data returned.
   */
  syncIntervalMinutes: number;
  jwtSecret: string;
  jwtExpiresSeconds: number;
  webOrigin: string;
  /**
   * Whether the auth session cookie gets the `Secure` attribute (browsers
   * silently drop `Secure` cookies over plain HTTP). Defaults to
   * `nodeEnv === 'production'`, but can be overridden explicitly for
   * deployments that run NODE_ENV=production behind plain HTTP (e.g. an
   * internal-only bastion host with no TLS termination) - without this,
   * login on such a deployment appears to succeed but every subsequent
   * request comes back 401 because the cookie never persisted.
   */
  cookieSecure: boolean;
}

export default (): AppConfig => {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  return {
    nodeEnv,
    port: parseInt(process.env.PORT ?? '3000', 10),
    tz: process.env.TZ ?? 'Asia/Shanghai',
    logLevel: process.env.LOG_LEVEL ?? 'log',
    databaseUrl: process.env.DATABASE_URL ?? '',
    syncIntervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES ?? '3', 10),
    jwtSecret: process.env.JWT_SECRET ?? '',
    jwtExpiresSeconds: parseInt(process.env.JWT_EXPIRES_SECONDS ?? '28800', 10),
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    cookieSecure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === 'true'
      : nodeEnv === 'production',
  };
};
