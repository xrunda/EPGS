import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MonitorExamDto, MonitorSummaryDto, SyncStatusDto } from '@epgs/shared-types';
import { Workbench } from './Workbench';

const examRows: MonitorExamDto[] = [
  {
    recordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    monitorLevel: 'RED',
    patientName: '测试患者甲',
    department: '内镜中心',
    bedNo: '12床',
    patientType: { code: 'I', name: '住院' },
    examItem: '胃镜',
    examDate: '2026-08-20',
    examTime: '10:30:00',
    matchedKeywords: ['腺癌', '浸润癌'],
  },
  {
    recordId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    monitorLevel: 'GREEN',
    patientName: null,
    department: null,
    bedNo: null,
    patientType: { code: 'O', name: null },
    examItem: null,
    examDate: null,
    examTime: null,
    matchedKeywords: [],
  },
];

const summary: MonitorSummaryDto = { total: 25, red: 10, yellow: 5, green: 9, unclassified: 1 };

const syncStatus: SyncStatusDto = {
  jobName: 'pacs-ris-incremental-sync',
  health: 'HEALTHY',
  lastSuccessAt: '2026-08-21T10:00:00.000Z',
  lastRunAt: '2026-08-21T10:00:00.000Z',
  lastRunStatus: 'SUCCEEDED',
  cursor: null,
  readCount: 10,
  successCount: 10,
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

function defaultFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/monitor/exams/')) {
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }
      if (url.includes('/api/monitor/exams')) {
        return jsonResponse({ items: examRows, total: 25, page: 1, pageSize: 20 });
      }
      if (url.includes('/api/monitor/summary')) {
        return jsonResponse(summary);
      }
      if (url.includes('/api/system/sync-status')) {
        return jsonResponse(syncStatus);
      }
      return jsonResponse({ items: [], total: 0, page: 1, pageSize: 20 });
    }),
  );
}

describe('Workbench', () => {
  beforeEach(() => {
    defaultFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the loading state, then the toolbar, summary cards, and table', async () => {
    render(<Workbench onOpenRules={vi.fn()} />);

    expect(screen.getByText('正在加载检查记录…')).toBeInTheDocument();

    expect(await screen.findByText('测试患者甲')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '内镜中心' })).toBeInTheDocument();
    expect(screen.getByText('同步正常 · 最后同步时间 2026-08-21 18:00:00')).toBeInTheDocument();

    const cards = screen.getByLabelText('关注等级汇总');
    expect(within(cards).getByText('全部')).toBeInTheDocument();
    expect(within(cards).getByText('25')).toBeInTheDocument();
    expect(within(cards).getByText('10')).toBeInTheDocument();
    expect(within(cards).getByText('未分级')).toBeInTheDocument();
    expect(within(cards).getByText('1')).toBeInTheDocument();

    const row1 = screen.getByRole('row', { name: /测试患者甲/ });
    expect(within(row1).getByText('红色')).toBeInTheDocument();
    expect(within(row1).getByText('内镜中心')).toBeInTheDocument();
    expect(within(row1).getByText('12床')).toBeInTheDocument();
    expect(within(row1).getByText('住院（I）')).toBeInTheDocument();
    expect(within(row1).getByText('2026-08-20')).toBeInTheDocument();
    expect(within(row1).getByText('10:30:00')).toBeInTheDocument();
    expect(within(row1).getByText('腺癌、浸润癌')).toBeInTheDocument();

    const row2 = screen.getByRole('row', { name: /绿色/ });
    expect(within(row2).getByText('O')).toBeInTheDocument();
    expect(within(row2).getAllByText('—')).toHaveLength(7);
  });

  it('sends the entered filters to the list and summary endpoints on submit', async () => {
    render(<Workbench onOpenRules={vi.fn()} />);
    await screen.findByText('测试患者甲');

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-31' } });
    fireEvent.change(screen.getByLabelText('科室'), { target: { value: '内镜中心' } });
    fireEvent.change(screen.getByLabelText('患者类型'), { target: { value: 'I' } });
    fireEvent.change(screen.getByLabelText('关注等级'), { target: { value: 'RED' } });
    fireEvent.change(screen.getByLabelText('检查项目'), { target: { value: '胃镜' } });
    fireEvent.change(screen.getByLabelText('姓名 / 关键词'), { target: { value: '腺癌' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
      expect(
        calls.some(
          (url) =>
            url.includes('examDateFrom=2026-08-01') &&
            url.includes('examDateTo=2026-08-31') &&
            url.includes('department=%E5%86%85%E9%95%9C%E4%B8%AD%E5%BF%83') &&
            url.includes('patientTypeCode=I') &&
            url.includes('level=RED') &&
            url.includes('examItem=%E8%83%83%E9%95%9C') &&
            url.includes('q=%E8%85%BA%E7%99%8C'),
        ),
      ).toBe(true);
    });
  });

  it('rejects a date range with only one bound set', async () => {
    render(<Workbench onOpenRules={vi.fn()} />);
    await screen.findByText('测试患者甲');

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    expect(screen.getByRole('alert')).toHaveTextContent('开始与结束日期需同时填写，或都不填写。');
    expect(
      vi
        .mocked(fetch)
        .mock.calls.map(([url]) => String(url))
        .filter((url) => url.includes('examDateFrom=')),
    ).toHaveLength(0);
  });

  it('resets filters back to an unfiltered request', async () => {
    render(<Workbench onOpenRules={vi.fn()} />);
    await screen.findByText('测试患者甲');

    fireEvent.change(screen.getByLabelText('科室'), { target: { value: '内镜中心' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await waitFor(() => {
      expect(
        vi
          .mocked(fetch)
          .mock.calls.map(([url]) => String(url))
          .some((url) => url.includes('department=')),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
      expect(
        calls.some((url) => url.includes('/api/monitor/exams') && !url.includes('department=')),
      ).toBe(true);
    });
    expect(screen.getByLabelText('科室')).toHaveValue('');
  });

  it('sets the level filter when a summary card is clicked', async () => {
    render(<Workbench onOpenRules={vi.fn()} />);
    await screen.findByText('测试患者甲');

    const cards = screen.getByLabelText('关注等级汇总');
    fireEvent.click(within(cards).getByRole('button', { name: /红色/ }));

    await waitFor(() => {
      expect(
        vi
          .mocked(fetch)
          .mock.calls.map(([url]) => String(url))
          .some((url) => url.includes('level=RED')),
      ).toBe(true);
    });
  });

  it('moves through API pages', async () => {
    render(<Workbench onOpenRules={vi.fn()} />);
    await screen.findByText('测试患者甲');
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => {
      expect(
        vi
          .mocked(fetch)
          .mock.calls.map(([url]) => String(url))
          .some((url) => url.includes('page=2')),
      ).toBe(true);
    });
    expect(screen.getByText('第 2 / 2 页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });

  it('refreshes list, summary, and sync status when 立即刷新 is clicked', async () => {
    render(<Workbench onOpenRules={vi.fn()} />);
    await screen.findByText('测试患者甲');
    const examsCalls = () =>
      vi
        .mocked(fetch)
        .mock.calls.map(([url]) => String(url))
        .filter((url) => url.includes('/api/monitor/exams'));
    const before = examsCalls().length;

    fireEvent.click(screen.getByRole('button', { name: '立即刷新' }));

    await waitFor(() => expect(examsCalls().length).toBeGreaterThan(before));
  });

  it('shows an error state with a working retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams')) {
          return jsonResponse({ error: { message: '数据库连接失败' } }, 500);
        }
        return jsonResponse(summary);
      }),
    );
    render(<Workbench onOpenRules={vi.fn()} />);

    expect(await screen.findByText('检查记录加载失败')).toBeInTheDocument();

    defaultFetch();
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByText('测试患者甲')).toBeInTheDocument();
  });

  it('shows an empty state when no records match', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams')) {
          return jsonResponse({ items: [], total: 0, page: 1, pageSize: 20 });
        }
        if (url.includes('/api/monitor/summary')) {
          return jsonResponse({ total: 0, red: 0, yellow: 0, green: 0, unclassified: 0 });
        }
        return jsonResponse(syncStatus);
      }),
    );
    render(<Workbench onOpenRules={vi.fn()} />);

    expect(await screen.findByText('没有符合条件的检查记录')).toBeInTheDocument();
  });

  it('falls back to 暂无同步记录 when sync has never run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams')) {
          return jsonResponse({ items: examRows, total: 2, page: 1, pageSize: 20 });
        }
        if (url.includes('/api/monitor/summary')) {
          return jsonResponse(summary);
        }
        return jsonResponse({ ...syncStatus, health: 'UNKNOWN', lastSuccessAt: null });
      }),
    );
    render(<Workbench onOpenRules={vi.fn()} />);

    expect(await screen.findByText('暂无同步记录')).toBeInTheDocument();
  });
});
