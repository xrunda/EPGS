import type {
  AlertLinkExamListDto,
  AlertLinkSummaryDto,
  MonitorExamDetailDto,
} from '@epgs/shared-types';

/**
 * Client for the WeCom alert H5 page (issue #72). The link token from the
 * WeCom card URL (`/alert?t=<token>`) is the credential: it is sent as a
 * Bearer header on every call and is NEVER exchanged for a workbench cookie.
 * Relative URLs for the same reason as authApi.ts (single-port reverse proxy).
 */

// Relative to the current origin - see apps/web/src/authApi.ts for why.
const API_BASE_URL = '';

/** Query parameter WeCom cards carry the token in (mirrors ALERT_LINK_TOKEN_PARAM). */
export const ALERT_TOKEN_PARAM = 't';

/** sessionStorage key the page parks the token under after stripping it from the URL. */
export const ALERT_TOKEN_STORAGE_KEY = 'epgs:alert-link-token';

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export class AlertLinkApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'AlertLinkApiError';
  }
}

/**
 * Reads the token for this page: from `?t=` on first open (then parks it in
 * sessionStorage and strips it from the address bar so it is not re-shared by
 * copying the URL and survives a pull-to-refresh), else from sessionStorage.
 * Returns null when neither has one.
 */
export function resolveAlertToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get(ALERT_TOKEN_PARAM);
  if (fromQuery) {
    try {
      window.sessionStorage.setItem(ALERT_TOKEN_STORAGE_KEY, fromQuery);
    } catch {
      // Storage may be unavailable (private mode); the in-memory token still works this load.
    }
    params.delete(ALERT_TOKEN_PARAM);
    const rest = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`,
    );
    return fromQuery;
  }
  try {
    return window.sessionStorage.getItem(ALERT_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

async function request<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as T | ErrorEnvelope;
  if (!response.ok) {
    const error = (body as ErrorEnvelope).error;
    throw new AlertLinkApiError(
      error?.message ?? '请求失败，请稍后重试',
      error?.code ?? 'HTTP_ERROR',
      response.status,
    );
  }
  return body as T;
}

export function getAlertLinkSummary(token: string): Promise<AlertLinkSummaryDto> {
  return request('/api/alert-links/me', token);
}

export function listAlertLinkExams(token: string): Promise<AlertLinkExamListDto> {
  return request('/api/alert-links/me/exams', token);
}

export function getAlertLinkExamDetail(token: string, id: string): Promise<MonitorExamDetailDto> {
  return request(`/api/alert-links/me/exams/${encodeURIComponent(id)}`, token);
}
