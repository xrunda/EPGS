import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MonitorLevelConflictTodoDto } from '@epgs/shared-types';
import { LEVEL_CONFLICT_DEFAULT_DAYS } from '@epgs/shared-types';
import { LevelConflictsModal } from './LevelConflictsModal';

/**
 * 关注等级分歧弹窗（issue #103）。
 *
 * 这里断的是四件事：
 *  1. 一组分歧被完整读出来 —— 两条配置各是什么等级、落在哪一列、涉及多少条、
 *     什么时候最后一次出现；
 *  2. 已读/未读是服务端的状态，标记后按响应更新那一行，未读计数跟着本地算；
 *  3. 窗口与状态过滤真的发出去了（`days` / `read` 是能改变结果的参数，不是摆设）；
 *  4. 页面不含患者信息 —— 这是配置侧的列表，wire 上本来就没有，界面也不许编。
 */

const conflict: MonitorLevelConflictTodoDto = {
  conflictKey:
    '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:FINDINGS:YELLOW:RED',
  keyword: '腺癌',
  keywordLevel: 'YELLOW',
  semanticName: '明确或高度疑似恶性病变',
  semanticLevel: 'RED',
  field: 'FINDINGS',
  recordCount: 4,
  lastSeenAt: '2026-09-26T02:30:00.000Z',
  readAt: null,
};

const readConflict: MonitorLevelConflictTodoDto = {
  ...conflict,
  conflictKey: conflict.conflictKey.replace('YELLOW:RED', 'RED:RED'),
  keyword: '糜烂',
  semanticName: '性质待定、需活检或短期复查的病变',
  field: 'IMPRESSION',
  recordCount: 1,
  lastSeenAt: '2026-09-20T01:00:00.000Z',
  readAt: '2026-09-21T03:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** 安装 fetch 替身：GET 是列表，PUT/DELETE 是标记已读/未读。 */
function installFetch(
  overrides: { items?: MonitorLevelConflictTodoDto[]; listError?: Response } = {},
): void {
  const items = overrides.items ?? [conflict, readConflict];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT' || init?.method === 'DELETE') {
        return jsonResponse({
          conflictKey: decodeURIComponent(url.split('/level-conflicts/')[1].replace('/read', '')),
          readAt: init.method === 'PUT' ? '2026-09-27T08:00:00.000Z' : null,
        });
      }
      if (overrides.listError) return overrides.listError;
      return jsonResponse({
        items,
        days: LEVEL_CONFLICT_DEFAULT_DAYS,
        unreadCount: items.filter((item) => item.readAt === null).length,
      });
    }),
  );
}

/**
 * 最近一次列表请求的查询串。取最后一次而不是第一次：窗口/状态改了以后会产生新
 * 的请求，而那正是这几条用例要看的东西。
 */
function listQuery(): URLSearchParams {
  const calls = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === undefined);
  return new URL(String(calls.at(-1)?.[0]), 'http://localhost').searchParams;
}

/** 工具栏那一行的文字（数字两边有 <strong>，按整块文本读）。 */
function toolbarText(): string {
  const toolbar = document.querySelector('.rules-toolbar');
  if (!toolbar) throw new Error('工具栏不在页面上');
  return toolbar.textContent ?? '';
}

describe('LevelConflictsModal', () => {
  beforeEach(() => {
    installFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads out both sides of a disagreement, where they met, and how many records show it', async () => {
    render(<LevelConflictsModal open onClose={vi.fn()} />);

    await screen.findByText('腺癌');
    const row = screen.getByRole('row', { name: /腺癌/ });
    // Both sides by name AND by level: naming only one of them would leave the
    // reader to work out which row on the doctor's screen it collided with.
    expect(within(row).getByText('黄色关注')).toBeInTheDocument();
    expect(within(row).getByText('明确或高度疑似恶性病变')).toBeInTheDocument();
    expect(within(row).getByText('红色关注')).toBeInTheDocument();
    // The column they met in, and the sense of scale.
    expect(within(row).getByText('报告内容')).toBeInTheDocument();
    expect(within(row).getByText('4')).toBeInTheDocument();
    // Asia/Shanghai wall time, same format as the workbench's sync line.
    expect(within(row).getByText('2026-09-26 10:30')).toBeInTheDocument();
  });

  it('counts the unread entries and shows each entry its own state', async () => {
    render(<LevelConflictsModal open onClose={vi.fn()} />);

    await screen.findByText('腺癌');
    expect(toolbarText()).toContain('共 2 组关注等级分歧，其中未读 1 组');
    const unreadRow = screen.getByRole('row', { name: /腺癌/ });
    const readRow = screen.getByRole('row', { name: /糜烂/ });
    expect(within(unreadRow).getByText('未读')).toBeInTheDocument();
    expect(within(readRow).getByText('已读')).toBeInTheDocument();
    // The action follows the state: an already-read entry offers the way back.
    expect(
      within(unreadRow).getByRole('button', { name: /标为已读「腺癌」/ }),
    ).toBeInTheDocument();
    expect(
      within(readRow).getByRole('button', { name: /标为未读「糜烂」/ }),
    ).toBeInTheDocument();
  });

  it('marks an entry read and updates that row without refetching the list', async () => {
    render(<LevelConflictsModal open onClose={vi.fn()} />);
    await screen.findByText('腺癌');
    const callsBefore = vi.mocked(fetch).mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /标为已读「腺癌」/ }));

    const row = screen.getByRole('row', { name: /腺癌/ });
    await waitFor(() => expect(within(row).getByText('已读')).toBeInTheDocument());
    expect(within(row).getByRole('button', { name: /标为未读「腺癌」/ })).toBeInTheDocument();
    // The unread count came down by the same one, computed locally from the
    // response - the list order and the window never changed, so a refetch
    // would only make the table jump.
    expect(toolbarText()).toContain('共 2 组关注等级分歧，其中未读 0 组');
    expect(vi.mocked(fetch).mock.calls).toHaveLength(callsBefore + 1);
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.method).toBe('PUT');
  });

  it('takes a read mark back', async () => {
    render(<LevelConflictsModal open onClose={vi.fn()} />);
    await screen.findByText('糜烂');

    fireEvent.click(screen.getByRole('button', { name: /标为未读「糜烂」/ }));

    const row = screen.getByRole('row', { name: /糜烂/ });
    await waitFor(() => expect(within(row).getByText('未读')).toBeInTheDocument());
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
  });

  it('sends the window and the state filter as the server reads them', async () => {
    render(<LevelConflictsModal open onClose={vi.fn()} />);
    await screen.findByText('腺癌');
    // Defaults: the documented window, and no state filter at all - "both" is
    // the absence of the parameter, not a second spelling of it.
    expect(listQuery().get('days')).toBe(String(LEVEL_CONFLICT_DEFAULT_DAYS));
    expect(listQuery().has('read')).toBe(false);

    fireEvent.change(screen.getByLabelText(/时间范围/), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(/状态/), { target: { value: 'false' } });

    await waitFor(() => expect(listQuery().get('days')).toBe('30'));
    expect(listQuery().get('read')).toBe('false');
  });

  it('says so plainly when there is nothing to look at', async () => {
    installFetch({ items: [] });
    render(<LevelConflictsModal open onClose={vi.fn()} />);

    expect(await screen.findByText('这段时间内没有发现关注等级分歧')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('reports a failed load instead of showing an empty list', async () => {
    // An error rendered as "no conflicts" is the worst possible reading: it
    // says the configuration is fine when nobody actually looked.
    installFetch({
      listError: jsonResponse({ error: { code: 'HTTP_ERROR', message: '服务暂时不可用' } }, 500),
    });
    render(<LevelConflictsModal open onClose={vi.fn()} />);

    expect(await screen.findByText('关注等级分歧加载失败')).toBeInTheDocument();
    expect(screen.queryByText('这段时间内没有发现关注等级分歧')).not.toBeInTheDocument();
  });

  it('offers a viewer no way to mark anything', async () => {
    render(<LevelConflictsModal open onClose={vi.fn()} canMarkRead={false} />);
    await screen.findByText('腺癌');

    expect(screen.queryByRole('button', { name: /标为/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('只读')).toHaveLength(2);
  });

  it('carries no patient information', async () => {
    // This list is a configuration surface: keyword, configured name, two
    // levels, a column name and two numbers. No record id, no report text, no
    // patient field - and the page must not invent any of it either.
    //
    // 患者 is deliberately NOT in the scan list: the notice says 「不含任何患者
    // 信息」, which is the promise itself, not a leak. What is banned is every
    // patient FIELD name - a table that grew a 姓名 or 床号 column would be the
    // regression this catches.
    render(<LevelConflictsModal open onClose={vi.fn()} />);
    await screen.findByText('腺癌');

    const rendered = document.body.textContent ?? '';
    for (const leak of ['姓名', '床号', '住院号', '检查号', '报告正文', '诊断意见']) {
      expect(rendered).not.toContain(leak);
    }
    // Positive control: the promise really is on screen.
    expect(rendered).toContain('不含任何患者信息');
  });

  it('closes on Escape like every other modal here', async () => {
    const onClose = vi.fn();
    render(<LevelConflictsModal open onClose={onClose} />);
    await screen.findByText('腺癌');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });
});
