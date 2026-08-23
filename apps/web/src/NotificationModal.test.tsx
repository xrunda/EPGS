import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { NotificationChannelDto, NotificationTemplateDto } from '@epgs/shared-types';
import { NotificationModal } from './NotificationModal';

const channel: NotificationChannelDto = {
  id: 'channel-1',
  name: '全体护士群',
  webhookUrlMasked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=8d24****',
  isEnabled: true,
  createdAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-21T00:00:00.000Z',
  createdBy: 'admin',
  updatedBy: 'admin',
};

const template: NotificationTemplateDto = {
  id: 'template-1',
  name: '红色关注提醒',
  msgType: 'NEWS',
  titleTemplate: '红色关注提醒',
  contentTemplate: '{{redCount}} 例红色关注患者',
  coverImageUrl: null,
  linkUrl: null,
  isEnabled: true,
  createdAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-21T00:00:00.000Z',
  createdBy: 'admin',
  updatedBy: 'admin',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function renderModal(
  overrides: Partial<{ onClose: () => void; canManageNotifications: boolean }> = {},
) {
  return render(
    <NotificationModal
      open
      onClose={overrides.onClose ?? vi.fn()}
      canManageNotifications={overrides.canManageNotifications ?? true}
      actorId="notify-admin"
    />,
  );
}

describe('NotificationModal', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/variables')) {
          return jsonResponse([]);
        }
        if (url.includes('/presets')) {
          return jsonResponse([]);
        }
        if (url.includes('/api/notification-channels')) {
          return jsonResponse({ items: [channel], total: 1, page: 1, pageSize: 20 });
        }
        if (url.includes('/api/notification-templates')) {
          return jsonResponse({ items: [template], total: 1, page: 1, pageSize: 20 });
        }
        return jsonResponse({ error: { message: '未知请求' } }, 404);
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the dialog with the shared notice and channels first', async () => {
    renderModal();

    expect(screen.getByRole('dialog', { name: '消息推送配置' })).toBeInTheDocument();
    expect(
      screen.getByText('消息推送配置保存后即时生效；发送测试将真实推送到企业微信。'),
    ).toBeInTheDocument();
    expect(screen.getByText('正在加载渠道…')).toBeInTheDocument();
    expect(await screen.findByText('全体护士群')).toBeInTheDocument();
  });

  it('lazy-loads templates only after switching tabs', async () => {
    renderModal();
    await screen.findByText('全体护士群');
    expect(
      vi.mocked(fetch).mock.calls.some(
        ([url]) => String(url).includes('/api/notification-templates') && !String(url).includes('/variables'),
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: '模板' }));

    expect(screen.getByText('正在加载模板…')).toBeInTheDocument();
    expect(await screen.findByText('红色关注提醒')).toBeInTheDocument();
    expect(
      vi.mocked(fetch).mock.calls.some(
        ([url]) => String(url).includes('/api/notification-templates') && !String(url).includes('/variables'),
      ),
    ).toBe(true);
  });

  it('gates a tab switch away from unsaved edits behind confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderModal();
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '新增渠道' }));
    fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: '未保存' } });
    fireEvent.click(screen.getByRole('tab', { name: '模板' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByLabelText('渠道名称')).toBeInTheDocument();
    expect(screen.queryByText('正在加载模板…')).not.toBeInTheDocument();
  });

  it('gates closing with unsaved edits behind confirmation', async () => {
    const onClose = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderModal({ onClose });
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '新增渠道' }));
    fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: '未保存' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭消息推送配置' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes after confirming unsaved edits', async () => {
    const onClose = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderModal({ onClose });
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '新增渠道' }));
    fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: '未保存' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭消息推送配置' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows read-only lists on both tabs without any write entries', async () => {
    renderModal({ canManageNotifications: false });
    await screen.findByText('全体护士群');

    expect(screen.queryByRole('button', { name: '新增渠道' })).not.toBeInTheDocument();
    const channelRow = screen.getByRole('row', { name: /全体护士群/ });
    expect(within(channelRow).getByText('只读')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '模板' }));
    expect(await screen.findByText('红色关注提醒')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新增模板' })).not.toBeInTheDocument();
    const templateRow = screen.getByRole('row', { name: /红色关注提醒/ });
    expect(within(templateRow).getByText('只读')).toBeInTheDocument();
  });

  it('closes with Escape when nothing is unsaved', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await screen.findByText('全体护士群');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens the test-send dialog and Escape closes only that layer', async () => {
    renderModal();
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '发送测试' }));

    expect(await screen.findByRole('dialog', { name: '发送测试消息' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '消息推送配置' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: '发送测试消息' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '消息推送配置' })).toBeInTheDocument();
  });
});
