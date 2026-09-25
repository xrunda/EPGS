import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MonitorExamDetailDto } from '@epgs/shared-types';
import { DetailDrawer } from './DetailDrawer';

const detail: MonitorExamDetailDto = {
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
      semanticFiltered: false,
      semantic: null,
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

describe('DetailDrawer', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams/')) {
          return jsonResponse(detail);
        }
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the report, diagnosis, and hit evidence for a record', async () => {
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    expect(within(dialog).getByText('测试患者甲')).toBeInTheDocument();
    expect(within(dialog).getByText('住院（I）')).toBeInTheDocument();

    // Report and diagnosis are highlighted in place, original text unchanged.
    const paragraphs = dialog.querySelectorAll('p.drawer__text');
    expect(paragraphs[0].textContent).toBe('胃体见多发隆起型病变，考虑腺癌。');
    expect(paragraphs[1].textContent).toBe('胃体腺癌。');
    const marks = dialog.querySelectorAll('mark.hit-highlight');
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe('腺癌');
    expect(marks[1].textContent).toBe('腺癌');

    // The red label appears on the summary tag and the hit tag; the keyword
    // also shows in the two highlighted marks and the hit evidence list.
    expect(within(dialog).getAllByText('红色')).toHaveLength(2);
    expect(within(dialog).getAllByText('腺癌')).toHaveLength(3);
    expect(within(dialog).getByText('报告内容与诊断')).toBeInTheDocument();
    expect(within(dialog).getByText('…胃体见多发隆起型病变，考虑腺癌。…')).toBeInTheDocument();
    expect(within(dialog).getByText('规则 aaaaaaaa · v1')).toBeInTheDocument();
  });

  it('shows placeholders when the report or diagnosis is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams/')) {
          return jsonResponse({ ...detail, reportContent: null, diagnosis: null, hits: [] });
        }
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }),
    );
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    expect(dialog.querySelectorAll('mark.hit-highlight')).toHaveLength(0);
    expect(within(dialog).getByText('暂无报告内容')).toBeInTheDocument();
    expect(within(dialog).getByText('（未同步到报告正文）')).toBeInTheDocument();
    expect(within(dialog).getByText('暂无诊断')).toBeInTheDocument();
    expect(within(dialog).getByText('暂无命中记录')).toBeInTheDocument();
  });

  it('highlights multiple matched keywords without altering the original text', async () => {
    const multiDetail: MonitorExamDetailDto = {
      ...detail,
      reportContent: '胃体见多发息肉样隆起，考虑腺癌。',
      diagnosis: '胃体腺癌伴多发息肉。',
      hits: [
        detail.hits[0],
        {
          ruleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          ruleVersion: 1,
          keyword: '息肉',
          level: 'YELLOW',
          matchedField: 'REPORT_TEXT',
          contextSnippet: '…胃体见多发息肉样隆起…',
          matchedAt: '2026-08-21T00:00:00.000Z',
          semanticFiltered: false,
          semantic: null,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams/')) {
          return jsonResponse(multiDetail);
        }
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }),
    );
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    // 报告内容: 息肉 + 腺癌; 诊断: 腺癌 + 息肉 -> 4 marks total.
    const marks = dialog.querySelectorAll('mark.hit-highlight');
    expect(marks).toHaveLength(4);
    const [report, diagnosis] = dialog.querySelectorAll('p.drawer__text');
    expect(report.querySelectorAll('mark.hit-highlight')).toHaveLength(2);
    expect(report.textContent).toBe('胃体见多发息肉样隆起，考虑腺癌。');
    expect(diagnosis.querySelectorAll('mark.hit-highlight')).toHaveLength(2);
    expect(diagnosis.textContent).toBe('胃体腺癌伴多发息肉。');
  });

  it('renders no highlights when there are no hits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams/')) {
          return jsonResponse({ ...detail, hits: [] });
        }
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }),
    );
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    expect(dialog.querySelectorAll('mark.hit-highlight')).toHaveLength(0);
    expect(within(dialog).getByText('暂无命中记录')).toBeInTheDocument();
  });

  // Issue #87: a hit the AI judged not to express the rule's intent stays
  // visible (the keyword engine did fire) but is marked 未计入关注 and carries
  // the 上下文判读 line; it must NOT be highlighted as a reason for the visit.
  it('shows a filtered hit with its verdict but keeps it out of the highlights', async () => {
    const filteredDetail: MonitorExamDetailDto = {
      ...detail,
      reportContent: '胃窦黏膜光滑，未见明显溃疡。',
      diagnosis: '慢性胃炎。',
      hits: [
        {
          ruleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          ruleVersion: 2,
          keyword: '溃疡',
          level: 'RED',
          matchedField: 'REPORT_TEXT',
          contextSnippet: '…未见明显溃疡…',
          matchedAt: '2026-08-21T00:00:00.000Z',
          semanticFiltered: true,
          semantic: {
            status: 'NEGATED',
            confidence: 'HIGH',
            reason: '该句是否认句，报告没有写存在溃疡。',
            judgedAt: '2026-08-21T00:05:00.000Z',
          },
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams/')) {
          return jsonResponse(filteredDetail);
        }
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }),
    );
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    // Highlighting means "this is why the patient is on the list" - a filtered
    // hit is precisely not that.
    expect(dialog.querySelectorAll('mark.hit-highlight')).toHaveLength(0);
    expect(dialog.querySelectorAll('p.drawer__text')[0].textContent).toBe(
      '胃窦黏膜光滑，未见明显溃疡。',
    );
    // The hit itself, and the count note, are still shown.
    expect(within(dialog).getByText('其中 1 条未计入关注')).toBeInTheDocument();
    expect(within(dialog).getByText('未计入关注')).toBeInTheDocument();
    const hit = dialog.querySelector('li.drawer__hit--filtered');
    expect(hit).not.toBeNull();
    expect(within(hit as HTMLElement).getByText('溃疡')).toBeInTheDocument();
    expect(within(hit as HTMLElement).getByText('报告是否定这个情况')).toBeInTheDocument();
    expect(within(hit as HTMLElement).getByText('（把握高）')).toBeInTheDocument();
    expect(
      within(hit as HTMLElement).getByText('该句是否认句，报告没有写存在溃疡。'),
    ).toBeInTheDocument();
    expect(dialog.querySelector('.drawer__hit-semantic-label')?.textContent).toBe('上下文判读');
  });

  it('does not invent a verdict for a hit that was never judged', async () => {
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    expect(within(dialog).queryByText('上下文判读')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/未计入关注/)).not.toBeInTheDocument();
    expect(dialog.querySelectorAll('li.drawer__hit--filtered')).toHaveLength(0);
  });

  it('shows a loading state while fetching the detail', () => {
    // A fetch that never settles keeps the drawer in its loading state; the
    // promise resolution after unmount would otherwise fire outside act().
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    expect(screen.getByText('正在加载检查详情…')).toBeInTheDocument();
  });

  it('moves keyboard focus into the dialog on open', async () => {
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    expect(dialog).toHaveFocus();
  });

  it('closes via the close button', async () => {
    const onClose = vi.fn();
    render(<DetailDrawer recordId={detail.recordId} onClose={onClose} />);
    await screen.findByRole('dialog', { name: '检查详情' });

    fireEvent.click(screen.getByRole('button', { name: '关闭检查详情' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<DetailDrawer recordId={detail.recordId} onClose={onClose} />);
    await screen.findByRole('dialog', { name: '检查详情' });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows a friendly not-found message with a retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse({ error: { message: '未找到' } }, 404)),
    );
    const onClose = vi.fn();
    render(<DetailDrawer recordId="missing" onClose={onClose} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    expect(await within(dialog).findByText('未找到该检查记录，可能已被移除。')).toBeInTheDocument();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams/')) {
          return jsonResponse(detail);
        }
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '重新加载' }));
    // The reloaded detail re-renders the highlighted report text.
    await waitFor(() => {
      expect(dialog.querySelectorAll('mark.hit-highlight')).toHaveLength(2);
      expect(dialog.querySelectorAll('p.drawer__text')[0].textContent).toBe(
        '胃体见多发隆起型病变，考虑腺癌。',
      );
    });
  });

  it('renders nothing when no record is selected', () => {
    const { container } = render(<DetailDrawer recordId={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
