import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MonitorExamDto, SyncStatusDto } from '@epgs/shared-types';
import App from './App';

const authUser = { id: 'user-1', username: 'doctor', displayName: '测试医生', roles: ['VIEWER'] };

const examRow: MonitorExamDto = {
  recordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  monitorLevel: 'RED',
  patientName: '测试患者甲',
  department: '内镜中心',
  bedNo: '12床',
  patientType: { code: 'I', name: '住院' },
  examItem: '胃镜',
  examDate: '2026-08-20',
  examTime: '10:30:00',
  matchedKeywords: ['腺癌'],
};

const syncStatus: SyncStatusDto = {
  jobName: 'pacs-ris-incremental-sync',
  health: 'UNKNOWN',
  lastSuccessAt: null,
  lastRunAt: null,
  lastRunStatus: null,
  cursor: null,
  readCount: 0,
  successCount: 0,
  failureCount: 0,
  errorSummary: null,
  syncIntervalMinutes: 15,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function defaultResponse(url: string): Promise<Response> {
  if (url.includes('/api/auth/me')) {
    return Promise.resolve(jsonResponse({ user: authUser }));
  }
  if (url.includes('/api/monitor/exams/')) {
    return Promise.resolve(jsonResponse({ error: { message: '未找到' } }, 404));
  }
  if (url.includes('/api/monitor/exams')) {
    return Promise.resolve(jsonResponse({ items: [examRow], total: 1, page: 1, pageSize: 20 }));
  }
  if (url.includes('/api/monitor/summary')) {
    return Promise.resolve(
      jsonResponse({ total: 1, red: 1, yellow: 0, green: 0, unclassified: 0 }),
    );
  }
  if (url.includes('/api/system/sync-status')) {
    return Promise.resolve(jsonResponse(syncStatus));
  }
  if (url.includes('/api/rules')) {
    return Promise.resolve(jsonResponse({ items: [], total: 0, page: 1, pageSize: 20 }));
  }
  if (url.includes('/api/notification-templates/variables')) {
    return Promise.resolve(jsonResponse([]));
  }
  if (url.includes('/api/notification-channels')) {
    return Promise.resolve(jsonResponse({ items: [], total: 0, page: 1, pageSize: 20 }));
  }
  if (url.includes('/api/notification-templates')) {
    return Promise.resolve(jsonResponse({ items: [], total: 0, page: 1, pageSize: 20 }));
  }
  return Promise.resolve(jsonResponse({ error: { message: '未知请求' } }, 404));
}

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => defaultResponse(String(input))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the authenticated monitor workbench', async () => {
    render(<App />);

    expect(await screen.findByAltText('菏泽市中医医院')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '内镜中心' })).toBeInTheDocument();
    expect(screen.getByLabelText('当前用户')).toHaveTextContent('测试医生');
    expect(screen.getByText('暂无同步记录')).toBeInTheDocument();

    expect(await screen.findByText('测试患者甲')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /测试患者甲/ });
    expect(within(row).getByText('红色')).toBeInTheDocument();
    expect(within(row).getByText('住院（I）')).toBeInTheDocument();
    expect(within(row).getByText('腺癌')).toBeInTheDocument();
  });

  it('opens notification configuration with a read-only list for a viewer', async () => {
    render(<App />);
    await screen.findByText('测试患者甲');

    fireEvent.click(screen.getByRole('button', { name: '消息推送' }));

    expect(screen.getByRole('dialog', { name: '消息推送配置' })).toBeInTheDocument();
    expect(await screen.findByText('没有符合条件的渠道')).toBeInTheDocument();
    // VIEWER fixture ⇒ 无任何写入口（新增/编辑/启停/发送测试）
    expect(screen.queryByRole('button', { name: '新增渠道' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '内镜中心' })).toBeInTheDocument();
  });

  it('opens monitor rule configuration without leaving the current page', async () => {
    render(<App />);
    await screen.findByText('测试患者甲');

    fireEvent.click(screen.getByRole('button', { name: '监测规则' }));

    expect(screen.getByRole('dialog', { name: '监测规则配置' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '内镜中心' })).toBeInTheDocument();
    expect(await screen.findByText('没有符合条件的监测规则')).toBeInTheDocument();
  });

  it('shows password and logout actions for the current user', async () => {
    render(<App />);

    expect(await screen.findByLabelText('当前用户')).toHaveTextContent('测试医生');
    expect(screen.getByRole('button', { name: '修改密码' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument();
  });

  it('opens the read-only detail drawer and preserves the workbench behind it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/auth/me')) {
          return Promise.resolve(jsonResponse({ user: authUser }));
        }
        if (url.includes('/api/monitor/exams/')) {
          return Promise.resolve(
            jsonResponse({
              ...examRow,
              reportContent: '胃体见多发隆起型病变，考虑腺癌。',
              diagnosis: '胃体腺癌。',
              hits: [
                {
                  ruleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  ruleVersion: 1,
                  keyword: '腺癌',
                  level: 'RED',
                  matchedField: 'REPORT_TEXT',
                  contextSnippet: '…胃体见多发隆起型病变，考虑腺癌。…',
                  matchedAt: '2026-08-21T00:00:00.000Z',
                },
              ],
            }),
          );
        }
        return defaultResponse(url);
      }),
    );
    render(<App />);
    await screen.findByText('测试患者甲');

    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    const paragraphs = dialog.querySelectorAll('p.drawer__text');
    expect(paragraphs[0].textContent).toBe('胃体见多发隆起型病变，考虑腺癌。');
    expect(paragraphs[1].textContent).toBe('胃体腺癌。');
    expect(within(dialog).getAllByText('腺癌')).toHaveLength(3);
    expect(screen.getByRole('heading', { name: '内镜中心' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查询' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('测试患者甲')).toHaveLength(2));
  });
});
