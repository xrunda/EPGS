import { useEffect, useState } from 'react';
import type { HealthStatus } from '@epgs/shared-types';

type ConnectivityState =
  | { kind: 'loading' }
  | { kind: 'connected'; health: HealthStatus }
  | { kind: 'error'; message: string };

// Relative to the current origin - see apps/web/src/authApi.ts for why.
const API_BASE_URL = '';

/**
 * Placeholder connectivity check: calls apps/api's GET /health and shows
 * the result. This proves web <-> api wiring works; it is not a real
 * business page (those come in issue #9+).
 */
export function ApiStatus(): JSX.Element {
  const [state, setState] = useState<ConnectivityState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    fetch(`${API_BASE_URL}/health`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Unexpected status ${res.status}`);
        }
        return (await res.json()) as HealthStatus;
      })
      .then((health) => {
        if (!cancelled) {
          setState({ kind: 'connected', health });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          setState({ kind: 'error', message });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return <p data-testid="api-status">正在检查 API 连接状态…</p>;
  }

  if (state.kind === 'error') {
    return (
      <p data-testid="api-status" role="alert">
        API 连接失败: {state.message}
      </p>
    );
  }

  return (
    <p data-testid="api-status">
      API 已连接 (status: {state.health.status}, version: {state.health.version})
    </p>
  );
}
