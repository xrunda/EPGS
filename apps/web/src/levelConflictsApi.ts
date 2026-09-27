import type {
  MonitorLevelConflictListDto,
  MonitorLevelConflictListQuery,
  MonitorLevelConflictStateDto,
} from '@epgs/shared-types';

// Relative to the current origin - see apps/web/src/authApi.ts for why.
const API_BASE_URL = '';

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export class LevelConflictsApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'LevelConflictsApiError';
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T | ErrorEnvelope;
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('epgs:auth-required'));
    const error = (body as ErrorEnvelope).error;
    throw new LevelConflictsApiError(
      error?.message ?? '请求失败，请稍后重试',
      error?.code ?? 'HTTP_ERROR',
      response.status,
    );
  }
  return body as T;
}

/**
 * The admin's level-conflict list (issue #103).
 *
 * `read` is passed through as the literal 'true'/'false' the server's query DTO
 * parses back into a boolean - never as `String(boolean)` off the wrong value,
 * and never as a second spelling of "both". Omitting it is the only way to ask
 * for both, which is what the unfiltered list is.
 */
export async function listLevelConflicts(
  query: MonitorLevelConflictListQuery,
): Promise<MonitorLevelConflictListDto> {
  const params = new URLSearchParams();
  if (query.days !== undefined) params.set('days', String(query.days));
  if (query.read !== undefined) params.set('read', String(query.read));
  const suffix = params.toString();
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/monitor/level-conflicts${suffix ? `?${suffix}` : ''}`, {
      credentials: 'include',
    }),
  );
}

/**
 * Record that an admin looked at this disagreement, or take that back.
 *
 * Both directions are idempotent server-side, and both return the state that
 * now holds - so the caller updates one row from the response instead of
 * refetching the whole list (and never has to guess what "nothing happened"
 * meant).
 */
export async function markLevelConflictRead(
  conflictKey: string,
  read: boolean,
): Promise<MonitorLevelConflictStateDto> {
  return parseResponse(
    await fetch(
      `${API_BASE_URL}/api/monitor/level-conflicts/${encodeURIComponent(conflictKey)}/read`,
      { method: read ? 'PUT' : 'DELETE', credentials: 'include' },
    ),
  );
}
