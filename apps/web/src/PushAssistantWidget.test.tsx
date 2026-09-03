import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PushAssistantStatusDto } from '@epgs/shared-types';
import { PushAssistantWidget } from './PushAssistantWidget';

const BASE: PushAssistantStatusDto = {
  phase: 'ON_DUTY',
  online: true,
  lastSeenAt: '2026-09-03T09:59:50.000Z',
  staleAfterMs: 90_000,
  nextTriggerAt: '2026-09-03T10:00:00.000Z', // today 18:00 Shanghai
  runningDays: 12,
  todaySyncCount: 47,
  lastSyncAt: '2026-09-03T09:32:00.000Z',
  events: [
    {
      id: 'e1',
      type: 'PUSH_DONE',
      occurredAt: '2026-09-02T10:00:00.000Z',
      summary: '每日关注 推送成功 · 2 群 · 3.2s',
      detail: {
        type: 'PUSH_DONE',
        ruleName: '每日关注',
        status: 'SUCCESS',
        groupCount: 2,
        elapsedMs: 3200,
        stages: [],
      },
    },
    {
      id: 'e2',
      type: 'KEYWORD_HIT',
      occurredAt: '2026-09-03T09:24:00.000Z',
      summary: '红色命中「食管裂孔疝」新增 1 例 · 电子胃镜检查',
      detail: { type: 'KEYWORD_HIT', keyword: '食管裂孔疝', level: 'RED', examItem: '电子胃镜检查' },
    },
  ],
  preview: {
    windowDate: '2026-09-03',
    counts: { red: 2, yellow: 5, green: 0, unclassified: 8, total: 15 },
    redKeywords: '食管裂孔疝 ×1、肿物 ×1',
    yellowKeywords: '—',
  },
  lastRun: null,
  runnableRules: [{ id: 'rule-1', name: '每日关注' }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function stubStatus(status: PushAssistantStatusDto): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/assistant/status')) return jsonResponse(status);
      if (String(url).includes('/run')) {
        return jsonResponse({ alreadyPushed: false, pushLogId: 'p1', status: 'SUCCESS', deliveries: [] });
      }
      return jsonResponse({}, 404);
    }),
  );
}

/** Renders and lets the initial status fetch resolve. */
async function renderReady(props: { onOpenLogs?: () => void } = {}) {
  const result = render(<PushAssistantWidget onOpenLogs={props.onOpenLogs ?? (() => {})} />);
  await waitFor(() => expect(screen.getByText('推送助理')).toBeInTheDocument());
  return result;
}

describe('PushAssistantWidget', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      now: new Date('2026-09-03T09:00:00.000Z'), // 17:00 Shanghai
      toFake: ['setInterval', 'clearInterval', 'Date'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the collapsed pill with a live countdown to the next push', async () => {
    stubStatus(BASE);
    await renderReady();

    // 17:00 -> 18:00 == 01:00:00 remaining.
    expect(screen.getByText('01:00:00')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('00:59:59')).toBeInTheDocument();
  });

  it('expands to the panel and shows the preview (unscoped全院) and activity feed', async () => {
    stubStatus(BASE);
    await renderReady();

    fireEvent.click(screen.getByRole('button', { name: '展开推送助理' }));

    const panel = screen.getByRole('region', { name: '推送助理' });
    expect(within(panel).getByText('值班中')).toBeInTheDocument();
    expect(within(panel).getByText(/预计推送/)).toHaveTextContent(
      '红色 2 例（食管裂孔疝 ×1、肿物 ×1）',
    );
    // Sync progress is STATE, not a feed row.
    expect(within(panel).getByText(/今日已同步 47 份/)).toBeInTheDocument();
    expect(
      within(panel).getByText('红色命中「食管裂孔疝」新增 1 例 · 电子胃镜检查'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('每日关注 推送成功 · 2 群 · 3.2s')).toBeInTheDocument();
    expect(within(panel).getByText(/连续运行 12 天/)).toBeInTheDocument();
  });

  it('shows OFFLINE state with a disabled 立即推送 button', async () => {
    stubStatus({ ...BASE, phase: 'OFFLINE', online: false });
    await renderReady();

    expect(screen.getByText('已失联')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开推送助理' }));
    expect(screen.getByRole('button', { name: '立即推送' })).toBeDisabled();
  });

  it('立即推送 confirms then calls the #61 run endpoint for every enabled rule', async () => {
    stubStatus(BASE);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderReady();

    fireEvent.click(screen.getByRole('button', { name: '展开推送助理' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '立即推送' }));
      await Promise.resolve();
    });

    await waitFor(() => {
      const runCall = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url, init]) =>
            String(url).includes('/api/notification-rules/rule-1/run') &&
            (init as RequestInit)?.method === 'POST',
        );
      expect(runCall).toBeTruthy();
    });
  });

  it('「推送日志」invokes the onOpenLogs callback', async () => {
    stubStatus(BASE);
    const onOpenLogs = vi.fn();
    await renderReady({ onOpenLogs });

    fireEvent.click(screen.getByRole('button', { name: '展开推送助理' }));
    fireEvent.click(screen.getByRole('button', { name: '推送日志' }));
    expect(onOpenLogs).toHaveBeenCalledTimes(1);
  });

  it('renders "未排程" when there is no enabled rule', async () => {
    stubStatus({ ...BASE, nextTriggerAt: null, preview: null, runnableRules: [], lastSyncAt: null });
    await renderReady();

    expect(screen.getByText('未排程')).toBeInTheDocument();
    expect(screen.getByText('--:--:--')).toBeInTheDocument();
  });
});
