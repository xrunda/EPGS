import type { AppRoleDto } from '@epgs/shared-types';

// Relative to the current origin (not a build-time absolute URL): behind a
// reverse proxy / NAT / 网闸 mapping, the browser may reach this app through
// an address that differs from the api's own IP, so the request must go to
// "wherever this page was loaded from" rather than a baked-in host.
const API_BASE_URL = '';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  /** 当前用户角色（来自 /api/auth/me，与后端 app_user_access 实时一致）。 */
  roles: AppRoleDto[];
  /**
   * 是否被授予患者明细授权（来自 /api/auth/me，issue #139）。
   *
   * 它决定「数据导出」入口出不出现 —— 没有这个授权的人看不到按钮，而不是看到
   * 一个点下去必然 403 的按钮（沿用「不出现点了没反应的入口」的一贯做法）。
   * **它不是访问控制**：真正的闸门在服务端 /api/monitor/export，
   * 这里只负责别让人白点。
   */
  patientDetail: boolean;
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
): Promise<Omit<AuthUser, 'roles' | 'patientDetail'>> {
  // login 响应刻意保持最小形状（不含 roles，也不含 patientDetail）；两者都需
  // 登录后经 /api/auth/me 获取 —— 类型上照实排除，别让调用方以为登录响应里就有。
  return (
    await request<{ user: Omit<AuthUser, 'roles' | 'patientDetail'> }>('/api/auth/login', {
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
