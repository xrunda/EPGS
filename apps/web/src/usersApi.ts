import type {
  AppUserAccessDto,
  AppUserDto,
  CreateAppUserBody,
  ListAppUsersQuery,
  PaginatedAppUsers,
  ResetAppUserPasswordBody,
  UpdateAppUserAccessBody,
  UpdateAppUserStatusBody,
} from '@epgs/shared-types';

// Relative to the current origin - see apps/web/src/authApi.ts for why.
const API_BASE_URL = '';

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export class UsersApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'UsersApiError';
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const body = (await response.json()) as T | ErrorEnvelope;
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('epgs:auth-required'));
    const error = (body as ErrorEnvelope).error;
    throw new UsersApiError(
      error?.message ?? '请求失败，请稍后重试',
      error?.code ?? 'HTTP_ERROR',
      response.status,
    );
  }
  return body as T;
}

function jsonRequest(method: 'POST' | 'PUT' | 'PATCH', body: unknown): RequestInit {
  return {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function listUsers(query: ListAppUsersQuery): Promise<PaginatedAppUsers> {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.isActive !== undefined) params.set('isActive', String(query.isActive));
  params.set('page', String(query.page ?? 1));
  params.set('pageSize', String(query.pageSize ?? 20));
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/users?${params.toString()}`, { credentials: 'include' }),
  );
}

export async function createUser(body: CreateAppUserBody): Promise<AppUserDto> {
  return parseResponse(await fetch(`${API_BASE_URL}/api/users`, jsonRequest('POST', body)));
}

export async function updateUserStatus(
  username: string,
  body: UpdateAppUserStatusBody,
): Promise<AppUserDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(username)}/status`, jsonRequest('PATCH', body)),
  );
}

export async function resetUserPassword(
  username: string,
  body: ResetAppUserPasswordBody,
): Promise<void> {
  await parseResponse(
    await fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(username)}/password`, jsonRequest('POST', body)),
  );
}

export async function deleteUser(username: string): Promise<void> {
  await parseResponse(
    await fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      credentials: 'include',
    }),
  );
}

export async function getUserAccess(username: string): Promise<AppUserAccessDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(username)}/access`, {
      credentials: 'include',
    }),
  );
}

export async function updateUserAccess(
  username: string,
  body: UpdateAppUserAccessBody,
): Promise<AppUserAccessDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(username)}/access`, jsonRequest('PUT', body)),
  );
}
