import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type {
  NotificationChannelDto,
  NotificationRuleDto,
  NotificationTemplateDto,
} from '@epgs/shared-types';
import { RulesPanel } from './RulesPanel';

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

const template: NotificationTemplateDto = {
  id: 'template-1',
  name: '日报',
  msgType: 'TEXT',
  titleTemplate: null,
  contentTemplate: '{{totalCount}}',
  coverImageUrl: null,
  linkUrl: null,
  isEnabled: true,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
  createdBy: 'admin',
  updatedBy: 'admin',
};

const channel: NotificationChannelDto = {
  id: 'channel-1',
  name: '总值班室群',
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
    onOpenLogs: (target: NotificationRuleDto) => void;
  }> = {},
) {
  return render(
    <RulesPanel
      actorId="notify-admin"
      canManageNotifications={overrides.canManageNotifications ?? true}
      onDirtyChange={vi.fn()}
      onOpenLogs={overrides.onOpenLogs ?? vi.fn()}
    />,
  );
}

describe('RulesPanel', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/notification-templates')) {
          return jsonResponse({ items: [template], total: 1, page: 1, pageSize: 100 });
        }
        if (url.includes('/api/notification-channels')) {
          return jsonResponse({ items: [channel], total: 1, page: 1, pageSize: 100 });
        }
        if (init?.method === 'POST' && url.includes('/run')) {
          return jsonResponse({
            alreadyPushed: false,
            pushLogId: 'log-1',
            status: 'SUCCESS',
            deliveries: [
              {
                id: 'delivery-1',
                channelId: channel.id,
                channelName: '总值班室群',
                status: 'SUCCESS',
                wecomErrCode: null,
                wecomErrMsg: null,
                sentAt: '2026-08-23T01:00:01.000Z',
              },
            ],
          });
        }
        if (init?.method === 'POST') {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          return jsonResponse(
            {
              ...rule,
              id: 'new-rule-id',
              name: payload.name,
              cron: payload.cron,
              templateId: payload.templateId,
            },
            201,
          );
        }
        if (init?.method === 'PUT') {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          return jsonResponse({ ...rule, ...payload });
        }
        return jsonResponse({ items: [rule], total: 1, page: 1, pageSize: 20 });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads and displays rules with cron, template, channel count and status', async () => {
    renderPanel();

    expect(screen.getByText('正在加载规则…')).toBeInTheDocument();
    expect(await screen.findByText('每日 9 点')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /每日 9 点/ });
    expect(within(row).getByText('0 9 * * *')).toBeInTheDocument();
    expect(within(row).getByText('Asia/Shanghai')).toBeInTheDocument();
    expect(within(row).getByText('日报')).toBeInTheDocument();
    expect(within(row).getByText('1')).toBeInTheDocument();
    expect(within(row).getByText('总值班室群')).toBeInTheDocument();
    expect(within(row).getByText('启用')).toBeInTheDocument();
  });

  it('creates a rule with the cron preset, template and channel, submitting actorId', async () => {
    renderPanel();
    await screen.findByText('每日 9 点');

    fireEvent.click(screen.getByRole('button', { name: '新增规则' }));
    expect(screen.getByRole('complementary', { name: '新增规则表单' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: '日报' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('规则名称'), { target: { value: '每日 9 点' } });
    fireEvent.click(screen.getByRole('button', { name: '每天 9:00' }));
    expect(screen.getByLabelText('推送时间（Cron，Asia/Shanghai）')).toHaveValue('0 9 * * *');
    fireEvent.change(screen.getByLabelText('推送模板'), { target: { value: 'template-1' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '总值班室群' }));
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }));

    expect(await screen.findByText('规则已新增')).toBeInTheDocument();
    const postCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      name: '每日 9 点',
      cron: '0 9 * * *',
      templateId: 'template-1',
      channelIds: ['channel-1'],
      isEnabled: true,
      actorId: 'notify-admin',
    });
  });

  it('blocks saving without any selected channel and sends no request', async () => {
    renderPanel();
    await screen.findByText('每日 9 点');

    fireEvent.click(screen.getByRole('button', { name: '新增规则' }));
    expect(await screen.findByRole('option', { name: '日报' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('规则名称'), { target: { value: '无渠道规则' } });
    fireEvent.click(screen.getByRole('button', { name: '每天 9:00' }));
    fireEvent.change(screen.getByLabelText('推送模板'), { target: { value: 'template-1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('请至少选择一个推送渠道。');
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('toggles a rule without an optimistic-lock version', async () => {
    renderPanel();
    await screen.findByText('每日 9 点');

    fireEvent.click(screen.getByRole('button', { name: '停用“每日 9 点”' }));

    expect(await screen.findByText('规则已停用')).toBeInTheDocument();
    const putCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
      isEnabled: false,
      actorId: 'notify-admin',
    });
  });

  it('runs a rule once after confirm and shows the per-channel delivery result', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPanel();
    await screen.findByText('每日 9 点');

    fireEvent.click(screen.getByRole('button', { name: '立即执行一次' }));

    const feedback = await screen.findByRole('status');
    expect(feedback).toHaveTextContent('「每日 9 点」已执行：成功（共1 个渠道）');
    expect(within(feedback).getByText('总值班室群')).toBeInTheDocument();

    const runCall = vi
      .mocked(fetch)
      .mock.calls.find(([url, init]) => init?.method === 'POST' && String(url).includes('/run'));
    expect(runCall).toBeTruthy();
  });

  it('does not run without a confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPanel();
    await screen.findByText('每日 9 点');

    fireEvent.click(screen.getByRole('button', { name: '立即执行一次' }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      vi.mocked(fetch).mock.calls.some(([url, init]) => init?.method === 'POST' && String(url).includes('/run')),
    ).toBe(false);
  });

  it('opens the push log dialog for a rule', async () => {
    const onOpenLogs = vi.fn();
    renderPanel({ onOpenLogs });
    await screen.findByText('每日 9 点');

    fireEvent.click(screen.getByRole('button', { name: '日志' }));

    expect(onOpenLogs).toHaveBeenCalledWith(rule);
  });

  it('hides all write actions in read-only mode', async () => {
    renderPanel({ canManageNotifications: false });
    await screen.findByText('每日 9 点');

    expect(screen.queryByRole('button', { name: '新增规则' })).not.toBeInTheDocument();
    const row = screen.getByRole('row', { name: /每日 9 点/ });
    expect(within(row).getByText('只读')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: '立即执行一次' })).not.toBeInTheDocument();
  });

  it('maps a server error code to a friendly Chinese message', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/notification-templates')) {
        return jsonResponse({ items: [template], total: 1, page: 1, pageSize: 100 });
      }
      if (url.includes('/api/notification-channels')) {
        return jsonResponse({ items: [channel], total: 1, page: 1, pageSize: 100 });
      }
      if (init?.method === 'PUT') {
        return jsonResponse(
          { error: { code: 'NOTIFICATION_RULE_NOT_FOUND', message: 'missing' } },
          404,
        );
      }
      return jsonResponse({ items: [rule], total: 1, page: 1, pageSize: 20 });
    });
    renderPanel();
    await screen.findByText('每日 9 点');

    fireEvent.click(screen.getByRole('button', { name: '停用“每日 9 点”' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('推送规则不存在或已被删除。');
  });
});
