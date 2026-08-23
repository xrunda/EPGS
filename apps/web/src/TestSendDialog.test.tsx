import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NotificationChannelDto, NotificationTemplateDto } from '@epgs/shared-types';
import { TestSendDialog } from './TestSendDialog';

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

function renderDialog(
  preselect: { channelId?: string; templateId?: string } = {},
  onClose = vi.fn(),
) {
  render(<TestSendDialog open onClose={onClose} preselect={preselect} />);
  return onClose;
}

describe('TestSendDialog', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/test-send')) {
          return jsonResponse({
            success: true,
            renderedTitle: '红色预警通知',
            renderedContent: '红色关注数量：3',
            sentAt: '2026-08-21T01:02:03.000Z',
          });
        }
        if (url.includes('/api/notification-channels')) {
          return jsonResponse({ items: [channel], total: 1, page: 1, pageSize: 100 });
        }
        if (url.includes('/api/notification-templates')) {
          return jsonResponse({ items: [template], total: 1, page: 1, pageSize: 100 });
        }
        return jsonResponse({ error: { message: '未知请求' } }, 404);
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads channels and templates with pageSize 100 and preselects the source entry', async () => {
    renderDialog({ channelId: channel.id, templateId: template.id });

    expect(screen.getByText('正在加载渠道与模板…')).toBeInTheDocument();
    expect(await screen.findByText('全体护士群')).toBeInTheDocument();
    expect(screen.getByText('红色关注提醒')).toBeInTheDocument();
    expect(screen.getByLabelText('目标渠道')).toHaveValue(channel.id);
    expect(screen.getByLabelText('测试模板')).toHaveValue(template.id);
    expect(
      vi.mocked(fetch).mock.calls.some(
        ([url]) =>
          String(url).includes('/api/notification-channels') && String(url).includes('pageSize=100'),
      ),
    ).toBe(true);
    expect(
      vi.mocked(fetch).mock.calls.some(
        ([url]) =>
          String(url).includes('/api/notification-templates') && String(url).includes('pageSize=100'),
      ),
    ).toBe(true);
  });

  it('falls back to an empty selection when the preselected id is gone', async () => {
    renderDialog({ channelId: 'ghost-channel', templateId: template.id });

    expect(await screen.findByLabelText('目标渠道')).toHaveValue('');
    expect(screen.getByLabelText('测试模板')).toHaveValue(template.id);
  });

  it('disables send until both selects are chosen', async () => {
    renderDialog({ channelId: channel.id });
    await screen.findByText('全体护士群');

    expect(screen.getByRole('button', { name: '发送测试' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('测试模板'), { target: { value: template.id } });
    expect(screen.getByRole('button', { name: '发送测试' })).toBeEnabled();
  });

  it('does not send without confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderDialog({ channelId: channel.id, templateId: template.id });
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '发送测试' }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(
      vi.mocked(fetch).mock.calls.some(
        ([url, init]) => String(url).includes('/test-send') && init?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('sends after confirmation and renders the server-substituted preview verbatim', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDialog({ channelId: channel.id, templateId: template.id });
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '发送测试' }));

    expect(await screen.findByText('红色预警通知')).toBeInTheDocument();
    expect(screen.getByText('红色关注数量：3')).toBeInTheDocument();
    expect(screen.queryByText(/\{\{/)).not.toBeInTheDocument();
    const postCall = vi.mocked(fetch).mock.calls.find(
      ([url, init]) => String(url).includes('/test-send') && init?.method === 'POST',
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ templateId: template.id });
  });

  it('surfaces the WeCom error message from a send failure', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/test-send')) {
        return jsonResponse(
          {
            error: {
              code: 'NOTIFICATION_SEND_FAILED',
              message: 'wecom fail',
              details: { wecomErrCode: 93000, wecomErrMsg: 'invalid webhook key' },
            },
          },
          502,
        );
      }
      if (url.includes('/api/notification-channels')) {
        return jsonResponse({ items: [channel], total: 1, page: 1, pageSize: 100 });
      }
      if (url.includes('/api/notification-templates')) {
        return jsonResponse({ items: [template], total: 1, page: 1, pageSize: 100 });
      }
      return jsonResponse({ error: { message: '未知请求' } }, 404);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDialog({ channelId: channel.id, templateId: template.id });
    await screen.findByText('全体护士群');

    fireEvent.click(screen.getByRole('button', { name: '发送测试' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '企业微信发送失败：invalid webhook key',
    );
  });

  it('closes with Escape', async () => {
    const onClose = vi.fn();
    renderDialog({}, onClose);
    await screen.findByText('全体护士群');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
