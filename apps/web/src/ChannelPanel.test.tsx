import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { NotificationChannelDto } from '@epgs/shared-types';
import { ChannelPanel } from './ChannelPanel';

const channel: NotificationChannelDto = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: '全体护士群',
  webhookUrlMasked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=8d24****',
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

function renderPanel(
  overrides: Partial<{
    canManageNotifications: boolean;
    onOpenTestSend: (preselected: { channelId: string }) => void;
  }> = {},
) {
  return render(
    <ChannelPanel
      actorId="notify-admin"
      canManageNotifications={overrides.canManageNotifications ?? true}
      onDirtyChange={vi.fn()}
      onOpenTestSend={overrides.onOpenTestSend ?? vi.fn()}
    />,
  );
}

describe('ChannelPanel', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          return jsonResponse(
            {
              ...channel,
              id: 'new-channel-id',
              name: payload.name,
              webhookUrlMasked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=new****',
            },
            201,
          );
        }
        if (init?.method === 'PUT') {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          return jsonResponse({ ...channel, ...payload });
        }
        return jsonResponse({ items: [channel], total: 1, page: 1, pageSize: 20 });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads and displays channels with the masked webhook preview and status', async () => {
    renderPanel();

    expect(screen.getByText('正在加载渠道…')).toBeInTheDocument();
    expect(await screen.findByText('全体护士群')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /全体护士群/ });
    expect(
      within(row).getByText('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=8d24****'),
    ).toBeInTheDocument();
    expect(within(row).getByText('启用')).toBeInTheDocument();
  });

  it('filters by status with the isEnabled query param', async () => {
    renderPanel();
    await screen.findByText('全体护士群');

    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'true' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('isEnabled=true')),
      ).toBe(true);
    });
  });

  it('moves through API pages without loading an unbounded channel list', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const page = url.includes('page=2') ? 2 : 1;
      return jsonResponse({ items: [channel], total: 25, page, pageSize: 20 });
    });
    renderPanel();
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('page=2'))).toBe(
        true,
      );
    });
    expect(screen.getByText('第 2 / 2 页')).toBeInTheDocument();
  });

  it('creates a channel and submits the plaintext webhook URL', async () => {
    renderPanel();
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '新增渠道' }));
    fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: '护理部通知群' } });
    fireEvent.change(screen.getByLabelText('企业微信 Webhook URL'), {
      target: { value: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存渠道' }));

    expect(await screen.findByText('渠道已新增')).toBeInTheDocument();
    expect(screen.getByText('护理部通知群')).toBeInTheDocument();
    const postCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      name: '护理部通知群',
      webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123',
      isEnabled: true,
      actorId: 'notify-admin',
    });
  });

  it('blocks creating a channel without a webhook URL and sends no request', async () => {
    renderPanel();
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '新增渠道' }));
    fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: '无地址群' } });
    fireEvent.click(screen.getByRole('button', { name: '保存渠道' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '请输入企业微信 Webhook URL。',
    );
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('keeps the stored webhook when editing leaves the field blank', async () => {
    renderPanel();
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.getByLabelText('企业微信 Webhook URL')).toHaveValue('');
    expect(screen.getByPlaceholderText('留空则不修改')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: '改名后的群' } });
    fireEvent.click(screen.getByRole('button', { name: '保存渠道' }));

    expect(await screen.findByText('渠道已保存')).toBeInTheDocument();
    const putCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
    const body = JSON.parse(String(putCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ name: '改名后的群', actorId: 'notify-admin' });
    expect(body).not.toHaveProperty('webhookUrl');
  });

  it('submits a replacement webhook when editing fills one in', async () => {
    renderPanel();
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('企业微信 Webhook URL'), {
      target: { value: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=newkey' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存渠道' }));

    expect(await screen.findByText('渠道已保存')).toBeInTheDocument();
    const putCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
      webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=newkey',
    });
  });

  it('toggles a channel without an optimistic-lock version', async () => {
    renderPanel();
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '停用“全体护士群”' }));

    expect(await screen.findByText('渠道已停用')).toBeInTheDocument();
    const putCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
      isEnabled: false,
      actorId: 'notify-admin',
    });
  });

  it('opens the test-send dialog preselected with the channel', async () => {
    const onOpenTestSend = vi.fn();
    renderPanel({ onOpenTestSend });
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '发送测试' }));

    expect(onOpenTestSend).toHaveBeenCalledWith({ channelId: channel.id });
  });

  it('maps a server error code to a friendly Chinese message', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return jsonResponse(
          { error: { code: 'NOTIFICATION_CHANNEL_NOT_FOUND', message: 'missing' } },
          404,
        );
      }
      return jsonResponse({ items: [channel], total: 1, page: 1, pageSize: 20 });
    });
    renderPanel();
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '停用“全体护士群”' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('渠道不存在或已被删除。');
  });

  it('hides all write actions in read-only mode', async () => {
    renderPanel({ canManageNotifications: false });
    await screen.findByText('全体护士群');

    expect(screen.queryByRole('button', { name: '新增渠道' })).not.toBeInTheDocument();
    const row = screen.getByRole('row', { name: /全体护士群/ });
    expect(within(row).getByText('只读')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: '发送测试' })).not.toBeInTheDocument();
  });
});
