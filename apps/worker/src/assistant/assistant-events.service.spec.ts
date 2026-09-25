import { Test, TestingModule } from '@nestjs/testing';
import { MonitorLevel } from '@prisma/client';
import { AssistantEventsService } from './assistant-events.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Unit tests for the assistant activity-feed recorder (issue #70): the
 * payload shape written to assistant_event, the KEYWORD_HIT derivation after a
 * sync pass (RED/YELLOW only, enabled rules only, NO per-sync event), and the
 * "a feed write never breaks the sync" failure policy.
 */
describe('AssistantEventsService', () => {
  function makeFakePrisma() {
    return {
      assistantEvent: { create: jest.fn().mockResolvedValue({ id: 'evt-1' }) },
      monitorMatch: {
        groupBy: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
  }

  async function build(prisma: any): Promise<TestingModule> {
    return Test.createTestingModule({
      providers: [AssistantEventsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
  }

  it('record() writes {type, ...payload} into assistant_event.payload', async () => {
    const prisma = makeFakePrisma();
    const service = (await build(prisma)).get(AssistantEventsService);

    await service.record({
      type: 'PUSH_DONE',
      ruleName: '每日关注',
      status: 'SUCCESS',
      groupCount: 2,
      elapsedMs: 3200,
      stages: [{ name: 'deliver', elapsedMs: 3200 }],
    });

    expect(prisma.assistantEvent.create).toHaveBeenCalledWith({
      data: {
        type: 'PUSH_DONE',
        payload: {
          type: 'PUSH_DONE',
          ruleName: '每日关注',
          status: 'SUCCESS',
          groupCount: 2,
          elapsedMs: 3200,
          stages: [{ name: 'deliver', elapsedMs: 3200 }],
        },
      },
    });
  });

  it('recordSyncMatches emits a KEYWORD_HIT per notable (keyword, level) — no per-sync event', async () => {
    const prisma = makeFakePrisma();
    prisma.monitorMatch.groupBy.mockResolvedValue([
      { keyword: '恶性肿瘤', level: MonitorLevel.RED, _count: { _all: 1 } },
      { keyword: '溃疡', level: MonitorLevel.YELLOW, _count: { _all: 2 } },
      { keyword: '息肉', level: MonitorLevel.GREEN, _count: { _all: 5 } }, // dropped
    ]);
    prisma.monitorMatch.findFirst.mockResolvedValue({ record: { examItem: '电子胃镜检查' } });
    const service = (await build(prisma)).get(AssistantEventsService);

    await service.recordSyncMatches(4, new Date('2026-09-03T10:00:00Z'));

    const types = prisma.assistantEvent.create.mock.calls.map((c: any[]) => c[0].data.type);
    expect(types).toEqual(['KEYWORD_HIT', 'KEYWORD_HIT']); // no SYNC_DONE
    expect(prisma.assistantEvent.create.mock.calls[0][0].data.payload).toEqual({
      type: 'KEYWORD_HIT',
      keyword: '恶性肿瘤',
      level: MonitorLevel.RED,
      examItem: '电子胃镜检查',
    });
  });

  it('recordSyncMatches with 0 new reports writes nothing and does not query', async () => {
    const prisma = makeFakePrisma();
    const service = (await build(prisma)).get(AssistantEventsService);

    await service.recordSyncMatches(0, new Date());

    expect(prisma.assistantEvent.create).not.toHaveBeenCalled();
    expect(prisma.monitorMatch.groupBy).not.toHaveBeenCalled();
  });

  it('only counts effective matches from enabled rules within the sync window', async () => {
    const prisma = makeFakePrisma();
    const since = new Date('2026-09-03T10:00:00Z');
    prisma.monitorMatch.groupBy.mockResolvedValue([
      { keyword: '恶性肿瘤', level: MonitorLevel.RED, _count: { _all: 1 } },
    ]);
    const service = (await build(prisma)).get(AssistantEventsService);

    await service.recordSyncMatches(2, since);

    expect(prisma.monitorMatch.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        // Issue #87: a hit the AI semantic judge removed did not put anyone on
        // the watch list, so it must not appear in the duty-room feed.
        where: {
          matchedAt: { gte: since },
          rule: { isEnabled: true },
          semanticFiltered: false,
        },
      }),
    );
    // The exam item quoted in the feed line comes from a hit that counted -
    // same effective-hit condition, or the line could name a report whose only
    // hit was filtered.
    expect(prisma.monitorMatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          keyword: '恶性肿瘤',
          matchedAt: { gte: since },
          rule: { isEnabled: true },
          semanticFiltered: false,
        },
      }),
    );
  });

  it('a write failure is swallowed (feed is best-effort, never fails the sync)', async () => {
    const prisma = makeFakePrisma();
    prisma.assistantEvent.create.mockRejectedValue(new Error('db down'));
    prisma.monitorMatch.groupBy.mockResolvedValue([
      { keyword: '恶性肿瘤', level: MonitorLevel.RED, _count: { _all: 1 } },
    ]);
    const service = (await build(prisma)).get(AssistantEventsService);

    await expect(service.recordSyncMatches(1, new Date())).resolves.not.toThrow();
  });
});
