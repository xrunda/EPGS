import type {
  CreateMonitorRuleBody,
  ImportConfirmResult,
  ImportValidateResult,
  ListMonitorRulesQuery,
  MonitorRuleDto,
  PaginatedMonitorRules,
  UpdateMonitorRuleBody,
} from '@epgs/shared-types';

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export class RulesApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'RulesApiError';
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T | ErrorEnvelope;
  if (!response.ok) {
    const error = (body as ErrorEnvelope).error;
    throw new RulesApiError(
      error?.message ?? '请求失败，请稍后重试',
      error?.code ?? 'HTTP_ERROR',
      response.status,
    );
  }
  return body as T;
}

function jsonRequest(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function listRules(query: ListMonitorRulesQuery): Promise<PaginatedMonitorRules> {
  const params = new URLSearchParams();
  if (query.keyword) params.set('keyword', query.keyword);
  if (query.level) params.set('level', query.level);
  if (query.isEnabled !== undefined) params.set('isEnabled', String(query.isEnabled));
  params.set('page', String(query.page ?? 1));
  params.set('pageSize', String(query.pageSize ?? 20));
  return parseResponse(await fetch(`${API_BASE_URL}/api/rules?${params.toString()}`));
}

export async function createRule(body: CreateMonitorRuleBody): Promise<MonitorRuleDto> {
  return parseResponse(await fetch(`${API_BASE_URL}/api/rules`, jsonRequest('POST', body)));
}

export async function updateRule(id: string, body: UpdateMonitorRuleBody): Promise<MonitorRuleDto> {
  return parseResponse(await fetch(`${API_BASE_URL}/api/rules/${id}`, jsonRequest('PUT', body)));
}

export async function validateRulesImport(file: File): Promise<ImportValidateResult> {
  const form = new FormData();
  form.append('file', file);
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/rules/import/validate`, { method: 'POST', body: form }),
  );
}

export async function confirmRulesImport(
  importToken: string,
  actorId: string,
): Promise<ImportConfirmResult> {
  return parseResponse(
    await fetch(
      `${API_BASE_URL}/api/rules/import/confirm`,
      jsonRequest('POST', { importToken, actorId }),
    ),
  );
}
