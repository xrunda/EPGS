import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PushAssistantService } from './push-assistant.service';
import { PrismaService } from '../prisma/prisma.service';
import { MonitorService } from '../monitor/monitor.service';

/**
 * Unit tests for the assistant status assembler (issue #70): phase derivation
 * from heartbeat freshness + last run, the UNSCOPED preview window
 * (owner decision §4), "未排程" handling, activity-feed summaries, and
 * runningDays math. Fakes for Prisma + MonitorService; the DB-level behavior
 * is covered by the api e2e suite.
 */
describe('PushAssistantService', () => {
  const NOW = new Date('2026-09-03T09:00:00Z'); // 17:00 Shanghai

  function makeConfig(staleSeconds = 90): ConfigService {
    return { get: (_k: string, d?: unknown) => staleSeconds ?? d } as unknown as ConfigService;
  }

  function makeFakePrisma(over: Record<string, any> = {}) {
    return {
      assistantHeartbeat: {
        findUnique: jest.fn().mockResolvedValue(over.heartbeat ?? null),
      },
      assistantEvent: {
        findMany: jest.fn().mockResolvedValue(over.events ?? []),
        findFirst: jest.fn().mockResolvedValue(over.pushDoneEvent ?? null),
      },
      pushLog: {
        findFirst: jest.fn().mockResolvedValue(over.lastLog ?? null),
      },
      monitorMatch: {
        groupBy: jest.fn().mockResolvedValue(over.keywordGroups ?? []),
      },
      notificationRule: {
        findMany: jest.fn().mockResolvedValue(over.runnableRules ?? []),
      },
      syncJobLog: {
        findMany: jest.fn().mockResolvedValue(over.syncRuns ?? []),
      },
    };
  }

  function makeFakeMonitor(summary: Record<string, number> = {}): MonitorService {
    return {
      summary: jest.fn().mockResolvedValue({
        total: 0,
        red: 0,
        yellow: 0,
        green: 0,
        unclassified: 0,
        ...summary,
      }),
    } as unknown as MonitorService;
  }

  async function build(
    prisma: any,
    monitor: MonitorService,
    config = makeConfig(),
  ): Promise<PushAssistantService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushAssistantService,
        { provide: PrismaService, useValue: prisma },
        { provide: MonitorService, useValue: monitor },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    return module.get(PushAssistantService);
  }

  it('reports OFFLINE when there is no heartbeat row', async () => {
    const service = await build(makeFakePrisma(), makeFakeMonitor());
    const status = await service.getStatus(NOW);
    expect(status).toMatchObject({
      phase: 'OFFLINE',
      online: false,
      lastSeenAt: null,
      preview: null,
    });
  });

  it('reports OFFLINE when the heartbeat is older than staleAfterMs', async () => {
    const stale = new Date(NOW.getTime() - 120_000); // 2 min old, threshold 90s
    const service = await build(
      makeFakePrisma({
        heartbeat: { lastSeenAt: stale, nextTriggerAt: null, runningSince: stale },
      }),
      makeFakeMonitor(),
    );
    const status = await service.getStatus(NOW);
    expect(status.phase).toBe('OFFLINE');
    expect(status.online).toBe(false);
  });

  it('reports ON_DUTY with a preview when the heartbeat is fresh and a next trigger exists', async () => {
    const fresh = new Date(NOW.getTime() - 10_000);
    const nextTrigger = new Date('2026-09-03T10:00:00Z'); // today 18:00 Shanghai
    const monitor = makeFakeMonitor({ red: 2, yellow: 5, total: 7 });
    const prisma = makeFakePrisma({
      heartbeat: {
        lastSeenAt: fresh,
        nextTriggerAt: nextTrigger,
        runningSince: new Date('2026-09-01T00:00:00Z'),
      },
      keywordGroups: [{ keyword: '恶性肿瘤', level: 'RED', _count: { _all: 1 } }],
      runnableRules: [{ id: 'rule-1', name: '每日关注' }],
    });
    const service = await build(prisma, monitor);

    const status = await service.getStatus(NOW);

    expect(status.phase).toBe('ON_DUTY');
    expect(status.online).toBe(true);
    expect(status.nextTriggerAt).toBe('2026-09-03T10:00:00.000Z');
    // Preview targets the window the UPCOMING push will use (today), UNSCOPED.
    expect(monitor.summary).toHaveBeenCalledWith(
      { examDateFrom: '2026-09-03', examDateTo: '2026-09-03' },
      {},
    );
    expect(status.preview).toMatchObject({
      windowDate: '2026-09-03',
      counts: { red: 2, yellow: 5, total: 7 },
      redKeywords: '恶性肿瘤 ×1',
      yellowKeywords: '—',
    });
    // Issue #87: the preview counts EFFECTIVE hits only, so it matches the push
    // that will actually render and the 监控看板 the operator is comparing to.
    expect(prisma.monitorMatch.groupBy).toHaveBeenCalledWith({
      by: ['keyword', 'level'],
      where: {
        record: { examTime: { gte: expect.any(Date), lt: expect.any(Date) } },
        rule: { isEnabled: true },
        semanticFiltered: false,
      },
      _count: { _all: true },
    });
    // runningDays: 2026-09-01 -> 2026-09-03 = 2 days.
    expect(status.runningDays).toBe(2);
    expect(status.runnableRules).toEqual([{ id: 'rule-1', name: '每日关注' }]);
  });

  it('reports "未排程" (null preview / nextTriggerAt) when no rule is enabled', async () => {
    const fresh = new Date(NOW.getTime() - 10_000);
    const monitor = makeFakeMonitor();
    const service = await build(
      makeFakePrisma({
        heartbeat: { lastSeenAt: fresh, nextTriggerAt: null, runningSince: fresh },
      }),
      monitor,
    );
    const status = await service.getStatus(NOW);
    expect(status.phase).toBe('ON_DUTY');
    expect(status.nextTriggerAt).toBeNull();
    expect(status.preview).toBeNull();
    expect(monitor.summary).not.toHaveBeenCalled();
  });

  it('reports JUST_DONE when a push finished within the look-back window', async () => {
    const fresh = new Date(NOW.getTime() - 10_000);
    const finishedAt = new Date(NOW.getTime() - 5 * 60 * 1000); // 5 min ago
    const service = await build(
      makeFakePrisma({
        heartbeat: {
          lastSeenAt: fresh,
          nextTriggerAt: new Date('2026-09-04T10:00:00Z'),
          runningSince: fresh,
        },
        lastLog: {
          id: 'log-1',
          windowDate: '2026-09-03',
          trigger: 'SCHEDULED',
          status: 'SUCCESS',
          startedAt: new Date(finishedAt.getTime() - 3200),
          finishedAt,
          rule: { name: '每日关注', template: { name: '每日汇总' } },
          deliveries: [{ status: 'SUCCESS' }, { status: 'SUCCESS' }],
        },
        pushDoneEvent: {
          payload: {
            type: 'PUSH_DONE',
            ruleName: '每日关注',
            elapsedMs: 3200,
            stages: [{ name: 'deliver', elapsedMs: 3200 }],
          },
        },
      }),
      makeFakeMonitor({ red: 3, total: 42 }),
    );

    const status = await service.getStatus(NOW);

    expect(status.phase).toBe('JUST_DONE');
    expect(status.lastRun).toMatchObject({
      pushLogId: 'log-1',
      ruleName: '每日关注',
      windowDate: '2026-09-03',
      status: 'SUCCESS',
      groupCount: 2,
      elapsedMs: 3200,
      stages: [{ name: 'deliver', elapsedMs: 3200 }],
    });
  });

  it('renders activity-feed summaries privacy-safely (hits + pushes only, no sync rows)', async () => {
    const fresh = new Date(NOW.getTime() - 10_000);
    const service = await build(
      makeFakePrisma({
        heartbeat: { lastSeenAt: fresh, nextTriggerAt: null, runningSince: fresh },
        events: [
          {
            id: 'e1',
            type: 'PUSH_DONE',
            occurredAt: new Date('2026-09-02T10:00:00Z'),
            payload: {
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
            occurredAt: new Date('2026-09-02T02:24:00Z'),
            payload: {
              type: 'KEYWORD_HIT',
              keyword: '食管裂孔疝',
              level: 'RED',
              examItem: '电子胃镜检查',
            },
          },
        ],
      }),
      makeFakeMonitor(),
    );

    const status = await service.getStatus(NOW);
    expect(status.events.map((e) => e.summary)).toEqual([
      '每日关注 推送成功 · 2 群 · 3.2s',
      '红色命中「食管裂孔疝」新增 1 例 · 电子胃镜检查',
    ]);
    // No patient identifiers anywhere in the payload.
    for (const e of status.events) {
      expect(JSON.stringify(e)).not.toMatch(/patientName|住院号|bedNo/);
    }
  });

  it("surfaces today's sync progress as state (todaySyncCount / lastSyncAt), not feed rows", async () => {
    const fresh = new Date(NOW.getTime() - 10_000);
    const service = await build(
      makeFakePrisma({
        heartbeat: { lastSeenAt: fresh, nextTriggerAt: null, runningSince: fresh },
        syncRuns: [
          { successCount: 3, finishedAt: new Date('2026-09-03T08:45:00Z') },
          { successCount: 5, finishedAt: new Date('2026-09-03T05:00:00Z') },
        ],
      }),
      makeFakeMonitor(),
    );

    const status = await service.getStatus(NOW);
    expect(status.todaySyncCount).toBe(8);
    expect(status.lastSyncAt).toBe('2026-09-03T08:45:00.000Z');
  });
});
