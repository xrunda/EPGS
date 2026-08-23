import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from './AuthGate';

const user = { id: 'user-1', username: 'doctor', displayName: '测试医生', roles: ['VIEWER'] };

function response(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function renderGate() {
  render(
    <AuthGate>
      {({ user: currentUser, logout, openChangePassword }) => (
        <div>
          <span>欢迎，{currentUser.displayName}</span>
          <button onClick={openChangePassword}>修改密码</button>
          <button onClick={() => void logout()}>退出登录</button>
        </div>
      )}
    </AuthGate>,
  );
}

describe('AuthGate', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('checks the cookie session before rendering and shows login when unauthorized', async () => {
    const fetchMock = vi.fn().mockReturnValue(response(401, { error: { code: 'AUTH_REQUIRED' } }));
    vi.stubGlobal('fetch', fetchMock);
    renderGate();

    expect(screen.getByText('正在验证登录状态…')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '登录系统' })).toBeInTheDocument();
    expect(screen.getByText('忘记密码请联系系统管理员')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/auth/me'), {
      credentials: 'include',
    });
  });

  it('logs in with credentials included and never stores or displays a token', async () => {
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(response(401, { error: { code: 'AUTH_REQUIRED' } }))
      .mockReturnValueOnce(response(200, { user }))
      // 登录成功后 AuthGate 重拉 /api/auth/me 以取得 roles
      .mockReturnValueOnce(response(200, { user }));
    vi.stubGlobal('fetch', fetchMock);
    renderGate();

    fireEvent.change(await screen.findByLabelText('账号'), { target: { value: 'doctor' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password-1' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('欢迎，测试医生')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/login'),
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ username: 'doctor', password: 'password-1' }),
      }),
    );
    expect(document.body.textContent).not.toMatch(/token|password-1/);
  });

  it('shows a generic login error without revealing whether the account exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValueOnce(response(401, {}))
        .mockReturnValueOnce(response(401, { error: { code: 'AUTH_INVALID_CREDENTIALS' } })),
    );
    renderGate();
    fireEvent.change(await screen.findByLabelText('账号'), { target: { value: 'doctor' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong-password' } });
    fireEvent.submit(screen.getByRole('button', { name: '登录' }).closest('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent('账号或密码错误');
  });

  it('changes the password, clears the local session and returns to login', async () => {
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(response(200, { user }))
      .mockReturnValueOnce(response(200, { success: true }));
    vi.stubGlobal('fetch', fetchMock);
    renderGate();

    fireEvent.click(await screen.findByRole('button', { name: '修改密码' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-1' } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'password-2' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'password-2' } });
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));

    expect(await screen.findByText('密码修改成功，请使用新密码重新登录。')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '登录系统' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/auth/change-password'),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('logs out and returns to login even if the server request fails', async () => {
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(response(200, { user }))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    renderGate();

    fireEvent.click(await screen.findByRole('button', { name: '退出登录' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: '登录系统' })).toBeInTheDocument(),
    );
  });

  it('returns to login when a business API reports an expired session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response(200, { user })));
    renderGate();
    expect(await screen.findByText('欢迎，测试医生')).toBeInTheDocument();

    act(() => window.dispatchEvent(new Event('epgs:auth-required')));

    expect(await screen.findByRole('heading', { name: '登录系统' })).toBeInTheDocument();
  });

  it('closes the password dialog with Escape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response(200, { user })));
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: '修改密码' }));
    expect(screen.getByRole('dialog', { name: '修改密码' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: '修改密码' })).not.toBeInTheDocument();
  });
});
