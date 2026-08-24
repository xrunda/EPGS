import type {
  ListMonitorExamsQuery,
  MonitorExamDetailDto,
  MonitorFiltersQuery,
  MonitorSummaryDto,
  MonitorSummaryQuery,
  PaginatedMonitorExams,
  SyncStatusDto,
} from '@epgs/shared-types';

// Relative to the current origin - see apps/web/src/authApi.ts for why.
const API_BASE_URL = '';

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export class MonitorApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'MonitorApiError';
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T | ErrorEnvelope;
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('epgs:auth-required'));
    const error = (body as ErrorEnvelope).error;
    throw new MonitorApiError(
      error?.message ?? '请求失败，请稍后重试',
      error?.code ?? 'HTTP_ERROR',
      response.status,
    );
  }
  return body as T;
}

/** Appends only the filters that are actually set (empty strings are dropped). */
function toQueryString(query: MonitorFiltersQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.examDateFrom) params.set('examDateFrom', query.examDateFrom);
  if (query.examDateTo) params.set('examDateTo', query.examDateTo);
  if (query.department) params.set('department', query.department);
  if (query.patientTypeCode) params.set('patientTypeCode', query.patientTypeCode);
  if (query.level) params.set('level', query.level);
  if (query.examItem) params.set('examItem', query.examItem);
  if (query.patientName) params.set('patientName', query.patientName);
  if (query.keyword) params.set('keyword', query.keyword);
  return params;
}

export async function listExams(query: ListMonitorExamsQuery): Promise<PaginatedMonitorExams> {
  const params = toQueryString(query);
  params.set('page', String(query.page ?? 1));
  params.set('pageSize', String(query.pageSize ?? 20));
  if (query.sortBy) params.set('sortBy', query.sortBy);
  if (query.sortDir) params.set('sortDir', query.sortDir);
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/monitor/exams?${params.toString()}`, {
      credentials: 'include',
    }),
  );
}

export async function getExamSummary(query: MonitorSummaryQuery): Promise<MonitorSummaryDto> {
  const params = toQueryString(query);
  const queryString = params.toString();
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/monitor/summary${queryString ? `?${queryString}` : ''}`, {
      credentials: 'include',
    }),
  );
}

export async function getExamDetail(id: string): Promise<MonitorExamDetailDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/monitor/exams/${encodeURIComponent(id)}`, {
      credentials: 'include',
    }),
  );
}

export async function getSyncStatus(): Promise<SyncStatusDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/system/sync-status`, { credentials: 'include' }),
  );
}
