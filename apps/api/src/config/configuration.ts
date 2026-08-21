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
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  tz: process.env.TZ ?? 'Asia/Shanghai',
  logLevel: process.env.LOG_LEVEL ?? 'log',
  databaseUrl: process.env.DATABASE_URL ?? '',
});
