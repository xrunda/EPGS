export interface WorkerConfig {
  nodeEnv: string;
  port: number;
  tz: string;
  logLevel: string;
  syncIntervalMinutes: number;
  databaseUrl: string;
  /** 'fixture' (default, no real DB) | 'sql' (real PACS/RIS, see pacs-adapter). */
  pacsAdapterMode: 'fixture' | 'sql';
}

export default (): WorkerConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3001', 10),
  tz: process.env.TZ ?? 'Asia/Shanghai',
  logLevel: process.env.LOG_LEVEL ?? 'log',
  syncIntervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES ?? '15', 10),
  databaseUrl: process.env.DATABASE_URL ?? '',
  pacsAdapterMode: (process.env.PACS_ADAPTER_MODE as 'fixture' | 'sql') ?? 'fixture',
});
