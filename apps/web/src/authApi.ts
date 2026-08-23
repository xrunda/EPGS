import type { AppRoleDto } from '@epgs/shared-types';

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  /** 当前用户角色（来自 /api/auth/me，与后端 app_user_access 实时一致）。 */
  roles: AppRoleDto[];
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export class AuthApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: options.body
      ? { 'Content-Type': 'application/json', ...options.headers }
      : options.headers,
  });
  const body = (await response.json()) as T | ApiErrorBody;
  if (!response.ok) {
    const error = (body as ApiErrorBody).error;
    throw new AuthApiError(response.status, error?.code ?? 'AUTH_REQUEST_FAILED');
  }
  return body as T;
}

export async function getCurrentUser(): Promise<AuthUser> {
  return (await request<{ user: AuthUser }>('/api/auth/me')).user;
}

export async function login(
  username: string,
  password: string,
): Promise<Omit<AuthUser, 'roles'>> {
  // login 响应刻意保持最小形状（不含 roles）；roles 需登录后经 /api/auth/me 获取
  return (
    await request<{ user: Omit<AuthUser, 'roles'> }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  ).user;
}

export async function logout(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST' });
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
  confirmPassword: string,
): Promise<void> {
  await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
  });
}
