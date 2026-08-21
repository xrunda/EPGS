import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
    expect(within(dialog).getByText('胃体见多发隆起型病变，考虑腺癌。')).toBeInTheDocument();
    expect(within(dialog).getByText('胃体腺癌。')).toBeInTheDocument();

    // The red label appears on the summary tag and the hit tag.
    expect(within(dialog).getAllByText('红色')).toHaveLength(2);
    expect(within(dialog).getByText('腺癌')).toBeInTheDocument();
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
    expect(within(dialog).getByText('暂无报告内容')).toBeInTheDocument();
    expect(within(dialog).getByText('（未同步到报告正文）')).toBeInTheDocument();
    expect(within(dialog).getByText('暂无诊断')).toBeInTheDocument();
    expect(within(dialog).getByText('暂无命中记录')).toBeInTheDocument();
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
    expect(await screen.findByText('胃体见多发隆起型病变，考虑腺癌。')).toBeInTheDocument();
  });

  it('renders nothing when no record is selected', () => {
    const { container } = render(<DetailDrawer recordId={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
