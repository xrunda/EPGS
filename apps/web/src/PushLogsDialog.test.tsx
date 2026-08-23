import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { NotificationRuleDto, PushLogDto } from '@epgs/shared-types';
import { PushLogsDialog } from './PushLogsDialog';

const rule: NotificationRuleDto = {
  id: 'rule-1',
  name: '每日 9 点',
  cron: '0 9 * * *',
  templateId: 'template-1',
  templateName: '日报',
  channels: [{ id: 'rc-1', channelId: 'channel-1', name: '总值班室群' }],
  isEnabled: true,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
  createdBy: 'admin',
  updatedBy: 'admin',
};

const pushLog: PushLogDto = {
  id: 'log-1',
  ruleId: 'rule-1',
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

function renderDialog(
  overrides: Partial<{ logs: PushLogDto[]; total: number; onClose: () => void }> = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  const utils = render(<PushLogsDialog rule={rule} onClose={onClose} />);
  return { onClose, ...utils };
}

describe('PushLogsDialog', () => {
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

  it('loads and shows a push log row with trigger/status, and expands per-channel deliveries', async () => {
    renderDialog();

    const dialog = screen.getByRole('dialog', { name: '推送日志' });
    expect(await within(dialog).findByText('2026-08-23')).toBeInTheDocument();
    expect(within(dialog).getByText('手动')).toBeInTheDocument();
    expect(within(dialog).getByText('成功')).toBeInTheDocument();

    // Delivery details are behind the toggle (channel names are not leaked up-front).
    expect(within(dialog).queryByText('总值班室群')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '渠道明细' }));

    expect(within(dialog).getByRole('button', { name: '收起明细' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(dialog).getByText('总值班室群')).toBeInTheDocument();
    expect(within(dialog).getByText('错误信息')).toBeInTheDocument();
    expect(within(dialog).getByText('-')).toBeInTheDocument();
  });

  it('shows the empty state when the rule has never run', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ items: [], total: 0, page: 1, pageSize: 20 }));
    renderDialog();

    const dialog = screen.getByRole('dialog', { name: '推送日志' });
    expect(await within(dialog).findByText('暂无推送记录')).toBeInTheDocument();
  });

  it('renders SCHEDULED trigger and FAILED status labels', async () => {
    const failed = {
      ...pushLog,
      id: 'log-2',
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
    renderDialog();

    const dialog = screen.getByRole('dialog', { name: '推送日志' });
    expect(await within(dialog).findByText('定时')).toBeInTheDocument();
    expect(within(dialog).getByText('失败')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '渠道明细' }));
    expect(within(dialog).getByText('invalid webhook key')).toBeInTheDocument();
  });

  it('closes via the header close button and via Escape', async () => {
    const { onClose } = renderDialog();
    await screen.findByText('2026-08-23');

    fireEvent.click(screen.getByRole('button', { name: '关闭推送日志' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('maps a server error to a friendly Chinese message', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: { code: 'NOTIFICATION_RULE_NOT_FOUND', message: 'missing' } }, 404),
    );
    renderDialog();

    const dialog = screen.getByRole('dialog', { name: '推送日志' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('推送规则不存在或已被删除。');
  });
});
