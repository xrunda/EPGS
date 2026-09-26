import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  MonitorAttentionSourceDto,
  MonitorExamWorkbenchDto,
  MonitorLevelDto,
  MonitorSummaryDto,
  SyncStatusDto,
} from '@epgs/shared-types';
import { Workbench } from './Workbench';

/**
 * The list row carries attentionSource (issue #88) - required, so a fixture
 * cannot omit it and leave the reason silently wrong.
 */
const examRows: MonitorExamWorkbenchDto[] = [
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
    attentionSource: 'BOTH',
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
    attentionSource: 'NONE',
  },
];

/** One list row with everything the 关注理由 column reads spelled out. */
function examRow(
  patientName: string,
  monitorLevel: MonitorLevelDto,
  matchedKeywords: string[],
  attentionSource: MonitorAttentionSourceDto,
): MonitorExamWorkbenchDto {
  return {
    recordId: `${patientName}-record`,
    monitorLevel,
    patientName,
    department: '内镜中心',
    bedNo: '1床',
    patientType: { code: 'I', name: '住院' },
    examItem: '胃镜',
    examDate: '2026-08-20',
    examTime: '10:30:00',
    matchedKeywords,
    attentionSource,
  };
}

/** Serves one list of exam rows (plus the summary/sync chrome) for one test. */
function stubExams(items: MonitorExamWorkbenchDto[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/monitor/exams/')) {
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }
      if (url.includes('/api/monitor/exams')) {
        return jsonResponse({ items, total: items.length, page: 1, pageSize: 20 });
      }
      if (url.includes('/api/monitor/summary')) return jsonResponse(summary);
      if (url.includes('/api/system/sync-status')) return jsonResponse(syncStatus);
      return jsonResponse({ items: [], total: 0, page: 1, pageSize: 200 });
    }),
  );
}

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

const ruleRows = [
  { id: 'rule-1', keyword: '腺癌', level: 'RED' },
  { id: 'rule-2', keyword: '浸润癌', level: 'RED' },
];

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
      if (url.includes('/api/rules')) {
        return jsonResponse({ items: ruleRows, total: ruleRows.length, page: 1, pageSize: 200 });
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

    expect(within(cards).getByRole('button', { name: /红色/ })).toHaveClass('workbench-card--red');
    expect(within(cards).getByRole('button', { name: /黄色/ })).toHaveClass(
      'workbench-card--yellow',
    );
    expect(within(cards).getByRole('button', { name: /绿色/ })).toHaveClass(
      'workbench-card--green',
    );
    expect(within(cards).getByRole('button', { name: /全部/ })).not.toHaveClass(
      /workbench-card--(?:red|yellow|green)/,
    );
    expect(within(cards).getByRole('button', { name: /未分级/ })).not.toHaveClass(
      /workbench-card--(?:red|yellow|green)/,
    );

    const row1 = screen.getByRole('row', { name: /测试患者甲/ });
    // Issue #92: the row tag spells the level out (「红色关注」), like the drawer.
    expect(within(row1).getByText('红色关注')).toBeInTheDocument();
    expect(within(row1).getByText('内镜中心')).toBeInTheDocument();
    expect(within(row1).getByText('12床')).toBeInTheDocument();
    expect(within(row1).getByText('住院（I）')).toBeInTheDocument();
    expect(within(row1).getByText('2026-08-20')).toBeInTheDocument();
    expect(within(row1).getByText('10:30:00')).toBeInTheDocument();
    // Issue #94: the column answers 「为什么需要关注」 in words. BOTH is stated
    // as both, because a keyword alone may not be the higher of the two.
    expect(within(row1).getByText('命中「腺癌」等 2 处；报告提示需要关注')).toBeInTheDocument();
    // The level tag is its own element, so the reason cannot be mistaken for it.
    expect(row1.querySelectorAll('.level-tag')).toHaveLength(1);

    const row2 = screen.getByRole('row', { name: /绿色/ });
    expect(within(row2).getByText('绿色关注')).toBeInTheDocument();
    expect(within(row2).getByText('门诊（O）')).toBeInTheDocument();
    // Nothing found it, so there is no reason to state - and none is invented.
    expect(within(row2).getAllByText('—')).toHaveLength(7);
  });

  // Issue #94: one sentence per row, covering all four attention sources. The
  // AI-only row matters most - it carries a level with no keyword at all, so a
  // blank cell there would be a red record a doctor cannot explain.
  it('explains each row for all four attention sources', async () => {
    stubExams([
      examRow('测试患者甲', 'RED', ['腺癌', '浸润癌'], 'RULE'),
      examRow('测试患者乙', 'RED', [], 'AI_REPORT'),
      examRow('测试患者丙', 'RED', ['溃疡'], 'BOTH'),
      examRow('测试患者丁', 'UNCLASSIFIED', [], 'NONE'),
    ]);

    render(<Workbench onOpenRules={vi.fn()} />);
    await screen.findByText('测试患者甲');

    const reasonOf = (name: RegExp): string =>
      screen.getByRole('row', { name }).querySelector('.workbench__reason')?.textContent ?? '';

    expect(reasonOf(/测试患者甲/)).toBe('命中「腺癌」等 2 处');
    expect(reasonOf(/测试患者乙/)).toBe('报告提示需要关注');
    expect(reasonOf(/测试患者丙/)).toBe('命中「溃疡」；报告提示需要关注');
    expect(reasonOf(/测试患者丁/)).toBe('—');
  });

  /**
   * Issue #94: the workbench renders no mechanism vocabulary - this is the guard
   * for removing the source badge, which used to put 「AI 语义」 on every row.
   * Scans the rendered text, not the source.
   */
  it('uses only doctor-facing wording, never the implementation vocabulary', async () => {
    const { container } = render(<Workbench onOpenRules={vi.fn()} />);
    await screen.findByText('测试患者甲');

    const rendered = container.textContent ?? '';
    for (const leak of [
      '关键词监控',
      'AI 语义监控',
      '语义',
      '判读',
      'Prompt',
      '提示词',
      'LLM',
      '模型',
      '分类器',
      'JSON',
      'Schema',
      '置信度',
      '哈希',
      '大模型',
    ]) {
      expect(rendered).not.toContain(leak);
    }
    // Positive controls: the agreed wording really is on screen, so the scan
    // above cannot pass by rendering nothing.
    expect(rendered).toContain('红色关注');
    expect(rendered).toContain('关注理由');
    expect(rendered).toContain('监测规则');
  });

  it('applies all filters to the list but excludes level from the summary', async () => {
    render(<Workbench onOpenRules={vi.fn()} />);
    await screen.findByText('测试患者甲');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: '腺癌' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-31' } });
    fireEvent.change(screen.getByLabelText('科室'), { target: { value: '内镜中心' } });
    fireEvent.change(screen.getByLabelText('患者类型'), { target: { value: 'I' } });
    fireEvent.change(screen.getByLabelText('关注等级'), { target: { value: 'RED' } });
    fireEvent.change(screen.getByLabelText('检查项目'), { target: { value: '胃镜' } });
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '张三' } });
    fireEvent.change(screen.getByLabelText('命中关键词'), { target: { value: '腺癌' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
      const listCalls = calls.filter((url) => url.includes('/api/monitor/exams'));
      const summaryCalls = calls.filter((url) => url.includes('/api/monitor/summary'));
      const listCall = listCalls[listCalls.length - 1];
      const summaryCall = summaryCalls[summaryCalls.length - 1];

      for (const expected of [
        'examDateFrom=2026-08-01',
        'examDateTo=2026-08-31',
        'department=%E5%86%85%E9%95%9C%E4%B8%AD%E5%BF%83',
        'patientTypeCode=I',
        'examItem=%E8%83%83%E9%95%9C',
        'patientName=%E5%BC%A0%E4%B8%89',
        'keyword=%E8%85%BA%E7%99%8C',
      ]) {
        expect(listCall).toContain(expected);
        expect(summaryCall).toContain(expected);
      }
      expect(listCall).toContain('level=RED');
      expect(summaryCall).not.toContain('level=RED');
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

  it('filters the list by level without changing the summary scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams')) {
          return jsonResponse({ items: examRows, total: 10, page: 1, pageSize: 20 });
        }
        if (url.includes('/api/monitor/summary')) {
          return jsonResponse(
            url.includes('level=RED')
              ? { total: 10, red: 10, yellow: 0, green: 0, unclassified: 0 }
              : summary,
          );
        }
        return jsonResponse(syncStatus);
      }),
    );
    render(<Workbench onOpenRules={vi.fn()} />);
    await screen.findByText('测试患者甲');

    const cards = screen.getByLabelText('关注等级汇总');
    fireEvent.click(within(cards).getByRole('button', { name: /红色/ }));

    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
      const listCalls = calls.filter((url) => url.includes('/api/monitor/exams'));
      const summaryCalls = calls.filter((url) => url.includes('/api/monitor/summary'));
      const listCall = listCalls[listCalls.length - 1];
      const summaryCall = summaryCalls[summaryCalls.length - 1];

      expect(listCall).toContain('level=RED');
      expect(summaryCall).not.toContain('level=RED');
    });
    for (const accessibleName of [/全部 25/, /红色 10/, /黄色 5/, /绿色 9/, /未分级 1/]) {
      expect(within(cards).getByRole('button', { name: accessibleName })).toBeInTheDocument();
    }
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

  it('restores focus to the trigger button after the detail drawer closes', async () => {
    render(<Workbench onOpenRules={vi.fn()} />);
    await screen.findByText('测试患者甲');

    const trigger = screen.getAllByRole('button', { name: '查看详情' })[0];
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    await waitFor(() => expect(dialog).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole('dialog', { name: '检查详情' })).not.toBeInTheDocument();
  });

  it('shows the raw code for an unconfirmed patientType with no I/O fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams')) {
          return jsonResponse({
            items: [
              {
                recordId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                monitorLevel: 'UNCLASSIFIED',
                patientName: '测试患者丙',
                department: null,
                bedNo: null,
                patientType: { code: 'X', name: null },
                examItem: null,
                examDate: null,
                examTime: null,
                matchedKeywords: [],
                attentionSource: 'NONE',
              },
            ],
            total: 1,
            page: 1,
            pageSize: 20,
          });
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

    render(<Workbench onOpenRules={vi.fn()} />);

    const row = await screen.findByRole('row', { name: /测试患者丙/ });
    expect(within(row).getByText('X')).toBeInTheDocument();
  });
});
