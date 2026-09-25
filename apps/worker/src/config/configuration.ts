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
  /** AES-256-GCM key for NotificationChannel.webhookUrl decryption (same value as apps/api). Never logged. */
  notificationSecretKey: string;
  /** Hospital name rendered into {{hospitalName}} in push bodies. */
  hospitalName: string;
  /** Push-rule scheduler tick cadence in seconds (10-300, default 60). */
  notificationTickSeconds: number;
  /** Push assistant heartbeat write cadence in seconds (10-120, default 30). */
  assistantHeartbeatSeconds: number;
  /** Days to keep assistant_event rows before the heartbeat loop sweeps them (1-90, default 7). */
  assistantEventRetentionDays: number;
  /**
   * Issue #72: origin of the web app's /alert H5 page as reachable from WeCom
   * clients (same value as apps/api). null = alert-link cards disabled.
   */
  alertLinkBaseUrl: string | null;
  /** Issue #72: alert-link lifetime in hours (1-168, default 24). */
  alertLinkTtlHours: number;
  /**
   * Issue #87: the AI semantic judge (Validate Match). FALSE by default - with
   * it off the worker is byte-identical to pre-#87 behaviour (no queue scan, no
   * model call, no audit rows) and every keyword hit stands as recorded. The
   * judge can only ever REMOVE hits the keyword engine already found, never add
   * or re-level any; see packages/ai-semantic.
   *
   * Nothing below is validated as required-when-enabled: this process also runs
   * the sync job, so a missing model URL must disable the judge (loudly, in the
   * log) rather than stop the worker from booting.
   */
  semanticJudgeEnabled: boolean;
  /** OpenAI-compatible gateway base URL (e.g. http://10.0.0.5:8000/v1). Never logged. */
  semanticModelBaseUrl?: string;
  /** Bearer token for the gateway. Optional - a self-hosted gateway may need none. Never logged. */
  semanticModelApiKey?: string;
  /** Model identifier to send, recorded on every audit row. */
  semanticModelName?: string;
  /** Wire protocol. Only 'openai-chat' is implemented; the seam for the hospital's own gateway. */
  semanticModelApiStyle: string;
  /** Per-call timeout in ms (1000-60000, default 10000). */
  semanticModelTimeoutMs: number;
  /** Generated-token cap per call (64-4096, default 512). */
  semanticModelMaxTokens: number;
  /** Context window budget in characters (50-4000, default 400). */
  semanticContextCharBudget: number;
  /** Judge tick cadence in seconds (5-3600, default 30). */
  semanticJudgeIntervalSeconds: number;
  /** Hits claimed per tick (1-50, default 10). Kept small so a tick stays short. */
  semanticJudgeBatchSize: number;
  /** Attempts per hit before it is resolved terminally and fail-open (1-10, default 3). */
  semanticJudgeMaxAttempts: number;
  /** How long a claim is held before another worker may take the row (30-3600s, default 300). */
  semanticJudgeLeaseSeconds: number;
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
  notificationSecretKey: process.env.NOTIFICATION_SECRET_KEY ?? '',
  hospitalName: process.env.HOSPITAL_NAME ?? '菏泽市中医医院',
  notificationTickSeconds: parseInt(process.env.NOTIFICATION_TICK_SECONDS ?? '60', 10),
  assistantHeartbeatSeconds: parseInt(process.env.ASSISTANT_HEARTBEAT_SECONDS ?? '30', 10),
  assistantEventRetentionDays: parseInt(process.env.ASSISTANT_EVENT_RETENTION_DAYS ?? '7', 10),
  alertLinkBaseUrl: process.env.ALERT_LINK_BASE_URL?.trim() || null,
  alertLinkTtlHours: parseInt(process.env.ALERT_LINK_TTL_HOURS ?? '24', 10),
  semanticJudgeEnabled: process.env.SEMANTIC_JUDGE_ENABLED === 'true',
  semanticModelBaseUrl: process.env.SEMANTIC_MODEL_BASE_URL,
  semanticModelApiKey: process.env.SEMANTIC_MODEL_API_KEY,
  semanticModelName: process.env.SEMANTIC_MODEL_NAME,
  semanticModelApiStyle: process.env.SEMANTIC_MODEL_API_STYLE ?? 'openai-chat',
  semanticModelTimeoutMs: parseInt(process.env.SEMANTIC_MODEL_TIMEOUT_MS ?? '10000', 10),
  semanticModelMaxTokens: parseInt(process.env.SEMANTIC_MODEL_MAX_TOKENS ?? '512', 10),
  semanticContextCharBudget: parseInt(process.env.SEMANTIC_CONTEXT_CHAR_BUDGET ?? '400', 10),
  semanticJudgeIntervalSeconds: parseInt(process.env.SEMANTIC_JUDGE_INTERVAL_SECONDS ?? '30', 10),
  semanticJudgeBatchSize: parseInt(process.env.SEMANTIC_JUDGE_BATCH_SIZE ?? '10', 10),
  semanticJudgeMaxAttempts: parseInt(process.env.SEMANTIC_JUDGE_MAX_ATTEMPTS ?? '3', 10),
  semanticJudgeLeaseSeconds: parseInt(process.env.SEMANTIC_JUDGE_LEASE_SECONDS ?? '300', 10),
});
