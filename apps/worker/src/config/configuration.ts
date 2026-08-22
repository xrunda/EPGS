export interface WorkerConfig {
  nodeEnv: string;
  port: number;
  tz: string;
  logLevel: string;
  syncIntervalMinutes: number;
  syncPageSize: number;
  syncLookbackMinutes: number;
  syncFirstRunLookbackMinutes: number;
  syncMaxRetries: number;
  syncRetryBaseDelayMs: number;
  databaseUrl: string;
  /** 'csv' for local synthetic data | 'http' for the #24 REST gateway | 'soap' for the DHC/Ensemble gateway. */
  pacsAdapterMode: 'csv' | 'http' | 'soap';
  /** Only used when pacsAdapterMode='csv'. */
  pacsMockCsvPath?: string;
  /** Only used when pacsAdapterMode='http'. Never logged. */
  pacsHttpBaseUrl?: string;
  /** Only used when pacsAdapterMode='http'. Never logged. */
  pacsHttpServiceToken?: string;
  pacsHttpTimeoutMs: number;
  /** Only used when pacsAdapterMode='soap'. Never logged. */
  pacsSoapBaseUrl?: string;
  /** Only used when pacsAdapterMode='soap'. Never logged. */
  pacsSoapUsername?: string;
  /** Only used when pacsAdapterMode='soap'. Never logged. */
  pacsSoapPassword?: string;
  /** Only used when pacsAdapterMode='soap'. The DHCWebInterface KeyName for endoscopy reports. */
  pacsSoapKeyName?: string;
  pacsSoapTimeoutMs: number;
  /**
   * Skips TLS certificate verification for the SOAP gateway call. Node's
   * fetch (unlike `curl -k`) rejects self-signed/untrusted certs by default
   * with an opaque "fetch failed" error - internal PACS gateways commonly
   * use such certs, so this must be explicitly opted into per deployment
   * rather than defaulted on.
   */
  pacsSoapTlsInsecure: boolean;
}

export default (): WorkerConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3001', 10),
  tz: process.env.TZ ?? 'Asia/Shanghai',
  logLevel: process.env.LOG_LEVEL ?? 'log',
  syncIntervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES ?? '3', 10),
  syncPageSize: parseInt(process.env.SYNC_PAGE_SIZE ?? '200', 10),
  syncLookbackMinutes: parseInt(process.env.SYNC_LOOKBACK_MINUTES ?? '10', 10),
  syncFirstRunLookbackMinutes: parseInt(process.env.SYNC_FIRST_RUN_LOOKBACK_MINUTES ?? '1440', 10),
  syncMaxRetries: parseInt(process.env.SYNC_MAX_RETRIES ?? '5', 10),
  syncRetryBaseDelayMs: parseInt(process.env.SYNC_RETRY_BASE_DELAY_MS ?? '1000', 10),
  databaseUrl: process.env.DATABASE_URL ?? '',
  pacsAdapterMode: (process.env.PACS_ADAPTER_MODE as 'csv' | 'http') ?? 'csv',
  pacsMockCsvPath: process.env.PACS_MOCK_CSV_PATH,
  pacsHttpBaseUrl: process.env.PACS_HTTP_BASE_URL,
  pacsHttpServiceToken: process.env.PACS_HTTP_SERVICE_TOKEN,
  pacsHttpTimeoutMs: parseInt(process.env.PACS_HTTP_TIMEOUT_MS ?? '10000', 10),
  pacsSoapBaseUrl: process.env.PACS_SOAP_BASE_URL,
  pacsSoapUsername: process.env.PACS_SOAP_USERNAME,
  pacsSoapPassword: process.env.PACS_SOAP_PASSWORD,
  pacsSoapKeyName: process.env.PACS_SOAP_KEY_NAME,
  pacsSoapTimeoutMs: parseInt(process.env.PACS_SOAP_TIMEOUT_MS ?? '15000', 10),
  pacsSoapTlsInsecure: process.env.PACS_SOAP_TLS_INSECURE === 'true',
});
