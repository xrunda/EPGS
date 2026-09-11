import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppUserDto } from '@epgs/shared-types';
import { UsersModal } from './UsersModal';

const doctorUser: AppUserDto = {
  id: 'user-1',
  username: 'doctor',
  displayName: '李医生',
  isActive: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  roles: ['VIEWER'],
  patientDetail: false,
};

const unassignedUser: AppUserDto = {
  id: 'user-2',
  username: 'newcomer',
  displayName: '新账号',
  isActive: true,
  createdAt: '2026-09-05T00:00:00.000Z',
  roles: null,
  patientDetail: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function mockFetch(
  overrides: Partial<{
    onCreate: (payload: Record<string, unknown>) => void;
    onAccessUpdate: (username: string, payload: Record<string, unknown>) => void;
    onDelete: (username: string) => void;
    onStatus: (username: string, payload: Record<string, unknown>) => void;
  }> = {},
): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.includes('/access') && method === 'GET') {
      return jsonResponse({
        username: 'doctor',
        roles: ['VIEWER'],
        departmentScope: [],
        patientDetail: false,
        updatedAt: '2026-09-01T00:00:00.000Z',
      });
    }
    if (url.includes('/access') && method === 'PUT') {
      const username = decodeURIComponent(url.split('/users/')[1].split('/access')[0]);
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      overrides.onAccessUpdate?.(username, payload);
      return jsonResponse({
        username,
        roles: payload.roles,
        departmentScope: [],
        patientDetail: payload.patientDetail,
        updatedAt: '2026-09-06T00:00:00.000Z',
      });
    }
    if (url.includes('/status') && method === 'PATCH') {
      const username = decodeURIComponent(url.split('/users/')[1].split('/status')[0]);
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      overrides.onStatus?.(username, payload);
      return jsonResponse({ ...doctorUser, username, isActive: payload.isActive });
    }
    if (url.includes('/password') && method === 'POST') {
      return jsonResponse(undefined, 204);
    }
    if (method === 'DELETE') {
      const username = decodeURIComponent(url.split('/users/')[1]);
      overrides.onDelete?.(username);
      return jsonResponse(undefined, 204);
    }
    if (method === 'POST') {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      overrides.onCreate?.(payload);
      return jsonResponse(
        {
          id: 'new-user-id',
          username: payload.username,
          displayName: payload.displayName,
          isActive: true,
          createdAt: '2026-09-11T00:00:00.000Z',
          roles: null,
          patientDetail: false,
        },
        201,
      );
    }
    return jsonResponse({ items: [doctorUser], total: 1, page: 1, pageSize: 20 });
  });
}

describe('UsersModal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads and displays the account list with role labels', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<UsersModal open onClose={vi.fn()} />);

    expect(await screen.findByText('doctor')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /doctor/ });
    expect(within(row).getByText('李医生')).toBeInTheDocument();
    expect(within(row).getByText('启用')).toBeInTheDocument();
    expect(within(row).getByText('查看者')).toBeInTheDocument();
  });

  it('shows "未授权" for an account with no access grant (roles: null)', async () => {
    stubListResponse([unassignedUser]);
    render(<UsersModal open onClose={vi.fn()} />);

    expect(await screen.findByText('newcomer')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /newcomer/ });
    expect(within(row).getByText('未授权')).toBeInTheDocument();
  });

  it('creates an account and automatically opens its access editor', async () => {
    const onCreate = vi.fn();
    vi.stubGlobal('fetch', mockFetch({ onCreate }));
    render(<UsersModal open onClose={vi.fn()} />);
    await screen.findByText('doctor');

    fireEvent.click(screen.getByRole('button', { name: '新建账号' }));
    const form = screen.getByRole('complementary', { name: '新建账号表单' });
    fireEvent.change(within(form).getByLabelText('账号'), { target: { value: 'newdoc' } });
    fireEvent.change(within(form).getByLabelText('显示名'), { target: { value: '新医生' } });
    fireEvent.change(within(form).getByLabelText('密码'), { target: { value: 'password123' } });
    fireEvent.change(within(form).getByLabelText('确认密码'), { target: { value: 'password123' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存并分配角色' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'newdoc', displayName: '新医生' }),
      ),
    );
    // 保存后自动展开授权编辑区（issue #78 决策：不强制但默认引导）。
    expect(await screen.findByRole('complementary', { name: '账号授权表单' })).toBeInTheDocument();
  });

  it('rejects mismatched passwords before calling the API', async () => {
    const onCreate = vi.fn();
    vi.stubGlobal('fetch', mockFetch({ onCreate }));
    render(<UsersModal open onClose={vi.fn()} />);
    await screen.findByText('doctor');

    fireEvent.click(screen.getByRole('button', { name: '新建账号' }));
    const form = screen.getByRole('complementary', { name: '新建账号表单' });
    fireEvent.change(within(form).getByLabelText('账号'), { target: { value: 'newdoc' } });
    fireEvent.change(within(form).getByLabelText('显示名'), { target: { value: '新医生' } });
    fireEvent.change(within(form).getByLabelText('密码'), { target: { value: 'password123' } });
    fireEvent.change(within(form).getByLabelText('确认密码'), { target: { value: 'different456' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存并分配角色' }));

    expect(await screen.findByText('两次输入的密码不一致。')).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('edits access: preloads current roles, no department picker, saves full replacement', async () => {
    const onAccessUpdate = vi.fn();
    vi.stubGlobal('fetch', mockFetch({ onAccessUpdate }));
    render(<UsersModal open onClose={vi.fn()} />);
    await screen.findByText('doctor');

    fireEvent.click(screen.getByRole('button', { name: '授权' }));
    const form = await screen.findByRole('complementary', { name: '账号授权表单' });

    // Preloaded from GET .../access (roles: ['VIEWER']).
    expect(within(form).getByLabelText('查看者')).toBeChecked();
    expect(within(form).getByLabelText('系统管理员')).not.toBeChecked();
    // No department-scope picker anywhere in the form (issue #78 scope narrowing) - a
    // static全院提示是预期的，这里断言的是"没有可选择/编辑科室的表单控件"。
    expect(within(form).queryByLabelText(/科室/)).not.toBeInTheDocument();
    expect(within(form).queryByRole('combobox', { name: /科室/ })).not.toBeInTheDocument();

    fireEvent.click(within(form).getByLabelText('系统管理员'));
    fireEvent.click(within(form).getByRole('button', { name: '保存授权' }));

    await waitFor(() =>
      expect(onAccessUpdate).toHaveBeenCalledWith(
        'doctor',
        expect.objectContaining({ roles: ['VIEWER', 'SYSTEM_ADMIN'], patientDetail: false }),
      ),
    );
  });

  it('warns when saving access with zero roles selected', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<UsersModal open onClose={vi.fn()} />);
    await screen.findByText('doctor');

    fireEvent.click(screen.getByRole('button', { name: '授权' }));
    const form = await screen.findByRole('complementary', { name: '账号授权表单' });
    fireEvent.click(within(form).getByLabelText('查看者')); // uncheck the only preloaded role

    expect(
      screen.getByText(/未选择任何角色/),
    ).toBeInTheDocument();
  });

  it('resets a password with confirmation matching', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<UsersModal open onClose={vi.fn()} />);
    await screen.findByText('doctor');

    fireEvent.click(screen.getByRole('button', { name: '重置密码' }));
    const form = screen.getByRole('complementary', { name: '重置密码表单' });
    fireEvent.change(within(form).getByLabelText('新密码'), { target: { value: 'newpassword1' } });
    fireEvent.change(within(form).getByLabelText('确认新密码'), { target: { value: 'newpassword1' } });
    fireEvent.click(within(form).getByRole('button', { name: '重置密码' }));

    expect(await screen.findByText(/已重置 doctor 的密码/)).toBeInTheDocument();
  });

  it('toggles account status inline', async () => {
    const onStatus = vi.fn();
    vi.stubGlobal('fetch', mockFetch({ onStatus }));
    render(<UsersModal open onClose={vi.fn()} />);
    await screen.findByText('doctor');

    fireEvent.click(screen.getByRole('button', { name: '停用账号 doctor' }));

    await waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith('doctor', { isActive: false }),
    );
  });

  it('deletes an account after confirmation', async () => {
    const onDelete = vi.fn();
    vi.stubGlobal('fetch', mockFetch({ onDelete }));
    render(<UsersModal open onClose={vi.fn()} />);
    await screen.findByText('doctor');

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const confirmDialog = screen.getByRole('alertdialog', { name: '删除账号' });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('doctor'));
    expect(await screen.findByText(/账号 doctor 已删除/)).toBeInTheDocument();
  });

  it('cancelling the delete confirmation does not call the API', async () => {
    const onDelete = vi.fn();
    vi.stubGlobal('fetch', mockFetch({ onDelete }));
    render(<UsersModal open onClose={vi.fn()} />);
    await screen.findByText('doctor');

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const confirmDialog = screen.getByRole('alertdialog', { name: '删除账号' });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '取消' }));

    expect(screen.queryByRole('alertdialog', { name: '删除账号' })).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('keeps the current editor open when the discard prompt is declined', async () => {
    vi.stubGlobal('fetch', mockFetch());
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<UsersModal open onClose={vi.fn()} />);
    await screen.findByText('doctor');

    // Make the access editor dirty, then try to switch to another panel.
    fireEvent.click(screen.getByRole('button', { name: '授权' }));
    const accessForm = await screen.findByRole('complementary', { name: '账号授权表单' });
    fireEvent.click(within(accessForm).getByLabelText('系统管理员'));

    fireEvent.click(screen.getByRole('button', { name: '重置密码' }));

    expect(window.confirm).toHaveBeenCalled();
    // Declining must abort the switch entirely - the access editor and its edits stay.
    expect(screen.getByRole('complementary', { name: '账号授权表单' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: '重置密码表单' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('complementary', { name: '账号授权表单' })).getByLabelText('系统管理员')).toBeChecked();
  });

  it('Escape closes only the delete confirmation, not the whole modal', async () => {
    const onDelete = vi.fn();
    vi.stubGlobal('fetch', mockFetch({ onDelete }));
    const onClose = vi.fn();
    render(<UsersModal open onClose={onClose} />);
    await screen.findByText('doctor');

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByRole('alertdialog', { name: '删除账号' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('alertdialog', { name: '删除账号' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '用户管理' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('ignores a second status click while the first request is still in flight', async () => {
    const onStatus = vi.fn();
    const inner = mockFetch({ onStatus });
    let resolveStatus: (response: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/status')) {
          return new Promise<Response>((resolve) => {
            resolveStatus = resolve;
          }).then(() => inner(input, init));
        }
        return inner(input, init);
      }),
    );
    render(<UsersModal open onClose={vi.fn()} />);
    await screen.findByText('doctor');

    const button = screen.getByRole('button', { name: '停用账号 doctor' });
    fireEvent.click(button);
    fireEvent.click(button);
    resolveStatus(jsonResponse({ ...doctorUser, isActive: false }));

    await waitFor(() => expect(onStatus).toHaveBeenCalledTimes(1));
  });

  it('falls back a page after deleting the last account on the current page', async () => {
    const requestedPages: string[] = [];
    const inner = mockFetch();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.includes('/api/users')) {
          const page = new URL(url, 'http://localhost').searchParams.get('page') ?? '1';
          requestedPages.push(page);
          return jsonResponse({
            items: [{ ...doctorUser, username: `doctor-p${page}` }],
            total: 21,
            page: Number(page),
            pageSize: 20,
          });
        }
        return inner(input, init);
      }),
    );
    render(<UsersModal open onClose={vi.fn()} />);
    await screen.findByText('doctor-p1');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByText('doctor-p2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog', { name: '删除账号' })).getByRole('button', {
        name: '确认删除',
      }),
    );

    // Reload must target page 1 again, not leave the operator on an empty page 2.
    expect(await screen.findByText('doctor-p1')).toBeInTheDocument();
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument();
    expect(requestedPages[requestedPages.length - 1]).toBe('1');
  });

  function stubListResponse(items: AppUserDto[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse({ items, total: items.length, page: 1, pageSize: 20 })),
    );
  }
});
