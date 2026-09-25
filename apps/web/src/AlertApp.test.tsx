import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AlertLinkSummaryDto, MonitorExamDetailDto, MonitorExamDto } from '@epgs/shared-types';
import { AlertApp } from './AlertApp';
import { ALERT_TOKEN_STORAGE_KEY } from './alertLinkApi';

const TOKEN = 'k3JxPq9vL2mN8bR5tW7yA1cE4gH6jK0oS2uV4xZ6bD8';

const summary: AlertLinkSummaryDto = {
  level: 'RED',
  windowDate: '2026-09-05',
  total: 2,
  createdAt: '2026-09-05T01:00:00.000Z',
  expiresAt: '2026-09-06T01:00:00.000Z',
  hospitalName: '菏泽市中医医院',
};

const rows: MonitorExamDto[] = [
  {
    recordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    monitorLevel: 'RED',
    patientName: '王**',
    department: '内镜中心',
    bedNo: '3床',
    patientType: { code: 'I', name: '住院' },
    examItem: '无痛胃肠镜',
    examDate: '2026-09-05',
    examTime: '09:02:00',
    matchedKeywords: ['疑似穿孔'],
  },
  {
    recordId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    monitorLevel: 'RED',
    patientName: '李*',
    department: '消化内科',
    bedNo: '7床',
    patientType: { code: 'O', name: null },
    examItem: '胃镜',
    examDate: '2026-09-05',
    examTime: '08:47:00',
    matchedKeywords: [],
  },
];

const detail: MonitorExamDetailDto = {
  ...rows[0],
  reportContent: '胃窦部见溃疡灶，局部浆膜层显示中断，不除外疑似穿孔可能。',
  diagnosis: '胃溃疡，疑似穿孔。',
  hits: [
    {
      ruleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      ruleVersion: 2,
      keyword: '疑似穿孔',
      level: 'RED',
      matchedField: 'REPORT_TEXT',
      contextSnippet: '…不除外疑似穿孔可能。',
      matchedAt: '2026-09-05T01:05:00.000Z',
      semanticFiltered: false,
      semantic: null,
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Route = (url: string, init?: RequestInit) => Response;

function stubFetch(route: Route): ReturnType<typeof vi.fn> {
  const fetchMock = vi
    .fn()
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      route(String(input), init),
    );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function happyRoute(url: string): Response {
  if (url.endsWith('/api/alert-links/me')) return jsonResponse(summary);
  if (url.endsWith('/api/alert-links/me/exams'))
    return jsonResponse({ items: rows, total: rows.length });
  if (url.includes('/api/alert-links/me/exams/')) return jsonResponse(detail);
  return jsonResponse({ error: { code: 'NOT_FOUND', message: '未找到' } }, 404);
}

describe('AlertApp', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, '', `/alert?t=${TOKEN}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  it('opens the link with the token from ?t= as a Bearer header, parks it, strips it from the URL and renders the masked list', async () => {
    const fetchMock = stubFetch(happyRoute);

    render(<AlertApp />);

    expect(
      await screen.findByRole('heading', { name: '2026-09-05 · 共 2 例' }),
    ).toBeInTheDocument();
    expect(screen.getByText('红色关注')).toBeInTheDocument();
    expect(screen.getByText(/本链接有效至 9\/6 09:00/)).toBeInTheDocument();

    const list = screen.getByRole('list');
    const buttons = within(list).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(within(buttons[0]).getByText('王**')).toBeInTheDocument();
    expect(within(buttons[0]).getByText('3床')).toBeInTheDocument();
    expect(within(buttons[0]).getByText('疑似穿孔')).toBeInTheDocument();
    expect(within(buttons[1]).getByText('无命中关键词')).toBeInTheDocument();

    // Every call carries the token as a Bearer header, never as a cookie session.
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(init.credentials).toBeUndefined();
    }
    expect(window.location.search).toBe('');
    expect(window.sessionStorage.getItem(ALERT_TOKEN_STORAGE_KEY)).toBe(TOKEN);
    // The monitoring disclaimer and the workbench link are always present.
    expect(screen.getByText(/不作为正式诊断/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /登录工作台/ })).toHaveAttribute('href', '/');
  });

  it('opens a record on tap, highlights the hit in the report and diagnosis, and returns to the list', async () => {
    stubFetch(happyRoute);
    render(<AlertApp />);

    fireEvent.click(await screen.findByRole('button', { name: /王\*\*/ }));

    const region = await screen.findByRole('region', { name: '检查详情' });
    await waitFor(() => expect(within(region).getByText('报告内容')).toBeInTheDocument());
    const marks = region.querySelectorAll('mark.hit-highlight');
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe('疑似穿孔');
    expect(within(region).getByText('…不除外疑似穿孔可能。')).toBeInTheDocument();
    expect(within(region).getByText('报告内容与诊断')).toBeInTheDocument();
    // Original text stays intact under the marks.
    expect(region.querySelector('p.alert-text')?.textContent).toBe(
      '胃窦部见溃疡灶，局部浆膜层显示中断，不除外疑似穿孔可能。',
    );

    fireEvent.click(screen.getByRole('button', { name: /返回列表/ }));
    expect(await screen.findByRole('list')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '检查详情' })).not.toBeInTheDocument();
  });

  it('falls back to the parked token when the URL has none (pull-to-refresh)', async () => {
    window.history.replaceState({}, '', '/alert');
    window.sessionStorage.setItem(ALERT_TOKEN_STORAGE_KEY, TOKEN);
    const fetchMock = stubFetch(happyRoute);

    render(<AlertApp />);

    await screen.findByRole('list');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it('shows the invalid-link state without calling the API when there is no token at all', () => {
    window.history.replaceState({}, '', '/alert');
    const fetchMock = stubFetch(happyRoute);

    render(<AlertApp />);

    expect(screen.getByRole('alert')).toHaveTextContent('链接无效');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '登录工作台' })).toHaveAttribute('href', '/');
  });

  it('shows the expired state on 410 and the invalid state on 401', async () => {
    stubFetch(() =>
      jsonResponse({ error: { code: 'ALERT_LINK_EXPIRED', message: '链接已失效' } }, 410),
    );
    const { unmount } = render(<AlertApp />);
    expect(await screen.findByRole('alert')).toHaveTextContent('链接已失效');
    unmount();

    window.history.replaceState({}, '', `/alert?t=${TOKEN}`);
    stubFetch(() =>
      jsonResponse({ error: { code: 'ALERT_LINK_INVALID', message: '链接无效' } }, 401),
    );
    render(<AlertApp />);
    expect(await screen.findByRole('alert')).toHaveTextContent('链接无效');
  });

  it('offers a retry on a network/server error', async () => {
    let calls = 0;
    stubFetch((url) => {
      calls += 1;
      if (calls <= 2)
        return jsonResponse({ error: { code: 'INTERNAL', message: '服务异常' } }, 500);
      return happyRoute(url);
    });
    render(<AlertApp />);

    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法打开');
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('list')).toBeInTheDocument();
  });
});
