/**
 * Shared health-check response shape returned by the `GET /health` endpoint
 * on apps/api (and used internally by apps/worker's status mechanism).
 *
 * Consumed by apps/web to display API connectivity status.
 */
export interface HealthStatus {
  /** Simple liveness indicator. */
  status: 'ok' | 'error';
  /** Application version (from package.json), not build secrets. */
  version: string;
  /** Process uptime in seconds. */
  uptime: number;
}
