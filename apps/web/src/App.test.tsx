import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/auth/me')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              user: { id: 'user-1', username: 'doctor', displayName: '测试医生' },
            }),
          });
        }
        if (url.includes('/api/rules')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: 'ok', version: '0.1.0', uptime: 1.23 }),
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the authenticated workbench heading', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: '内镜中心' })).toBeInTheDocument();

    // Let the ApiStatus effect's fetch promise resolve so this test
    // doesn't leak a pending state update into the next one.
    await waitFor(() => expect(screen.getByTestId('api-status')).toHaveTextContent('API 已连接'));
  });

  it('calls the API /health endpoint and displays connectivity status', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('api-status')).toHaveTextContent('API 已连接');
    });

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/health'));
  });

  it('opens monitor rule configuration without leaving the current page', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '监测规则' }));

    expect(screen.getByRole('dialog', { name: '监测规则配置' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '内镜中心' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('api-status')).toHaveTextContent('API 已连接'));
    expect(await screen.findByText('没有符合条件的监测规则')).toBeInTheDocument();
  });

  it('shows the current user with password and logout actions', async () => {
    render(<App />);

    expect(await screen.findByText('测试医生')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '修改密码' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument();
  });
});
