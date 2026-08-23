import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { PushLogDto } from '@epgs/shared-types';
import { PushLogsPanel } from './PushLogsPanel';

const pushLog: PushLogDto = {
  id: 'log-1',
  ruleId: 'rule-1',
  ruleName: '每日 9 点',
  templateName: '日报',
  windowDate: '2026-08-23',
  trigger: 'MANUAL',
  status: 'SUCCESS',
  errorSummary: null,
  startedAt: '2026-08-23T01:00:00.000Z',
  finishedAt: '2026-08-23T01:00:01.000Z',
  deliveries: [
    {
      id: 'delivery-1',
      channelId: 'channel-1',
      channelName: '总值班室群',
      status: 'SUCCESS',
      wecomErrCode: null,
      wecomErrMsg: null,
      sentAt: '2026-08-23T01:00:01.000Z',
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function renderPanel() {
  return render(<PushLogsPanel />);
}

describe('PushLogsPanel', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        return jsonResponse({ items: [pushLog], total: 1, page: 1, pageSize: 20 });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads the aggregated log list and expands per-channel deliveries', async () => {
    renderPanel();

    expect(screen.getByText('正在加载推送日志…')).toBeInTheDocument();
    expect(await screen.findByText('每日 9 点')).toBeInTheDocument();
    expect(screen.getByText('日报')).toBeInTheDocument();
    expect(screen.getByText('2026-08-23')).toBeInTheDocument();
    expect(screen.getByText('手动')).toBeInTheDocument();
    expect(screen.getByText('成功')).toBeInTheDocument();
    expect(screen.getByText(/条推送记录/)).toBeInTheDocument();
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/notification-push-logs')),
    ).toBe(true);

    // Delivery details are behind the toggle (channel names are not leaked up-front).
    expect(screen.queryByText('总值班室群')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '渠道明细' }));

    expect(screen.getByRole('button', { name: '收起明细' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('总值班室群')).toBeInTheDocument();
    expect(screen.getByText('错误信息')).toBeInTheDocument();
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('shows the empty state when no rule has ever run', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ items: [], total: 0, page: 1, pageSize: 20 }));
    renderPanel();

    expect(await screen.findByText('暂无推送记录')).toBeInTheDocument();
  });

  it('renders SCHEDULED trigger and FAILED status labels', async () => {
    const failed = {
      ...pushLog,
      id: 'log-2',
      ruleName: '每日 18 点',
      templateName: '红色关注提醒',
      trigger: 'SCHEDULED' as const,
      status: 'FAILED' as const,
      finishedAt: '2026-08-23T01:00:01.000Z',
      deliveries: [
        {
          ...pushLog.deliveries[0],
          status: 'FAILED' as const,
          wecomErrCode: 93000,
          wecomErrMsg: 'invalid webhook key',
          sentAt: null,
        },
      ],
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ items: [failed], total: 1, page: 1, pageSize: 20 }));
    renderPanel();

    expect(await screen.findByText('定时')).toBeInTheDocument();
    expect(screen.getByText('失败')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '渠道明细' }));
    expect(screen.getByText('invalid webhook key')).toBeInTheDocument();
  });

  it('maps a server error to a friendly Chinese message', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent('请求失败，请检查网络后重试。');
  });
});
