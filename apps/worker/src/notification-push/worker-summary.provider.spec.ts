import { WorkerSummaryProvider } from './worker-summary.provider';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Unit tests for the worker's summary provider (issue: push rules). It must
 * reproduce the api's "今日新报告" buckets with its own GROUP BY (a scheduled
 * push cannot depend on the api being up); the day-window boundary math is
 * shared via resolveShanghaiDayRange, so here we only assert the Prisma where
 * shape and the level-key mapping.
 */
describe('WorkerSummaryProvider', () => {
  let prisma: { monitorRecord: { groupBy: jest.Mock } };
  let provider: WorkerSummaryProvider;

  beforeEach(() => {
    prisma = {
      monitorRecord: {
        groupBy: jest.fn(async () => [
          { currentLevel: 'RED', _count: { _all: 2 } },
          { currentLevel: 'YELLOW', _count: { _all: 1 } },
          { currentLevel: 'UNCLASSIFIED', _count: { _all: 1 } },
        ]),
      },
    };
    provider = new WorkerSummaryProvider(prisma as unknown as PrismaService);
  });

  it('counts examTime within the resolved Shanghai day window for a date', async () => {
    const summary = await provider.get({ date: '2026-08-23' });

    expect(prisma.monitorRecord.groupBy).toHaveBeenCalledWith({
      by: ['currentLevel'],
      where: {
        examTime: {
          // 2026-08-23T00:00:00+08:00 == 2026-08-22T16:00:00Z
          gte: new Date('2026-08-22T16:00:00.000Z'),
          // next day 00:00+08 == 2026-08-23T16:00:00Z
          lt: new Date('2026-08-23T16:00:00.000Z'),
        },
      },
      _count: { _all: true },
    });
    expect(summary).toEqual({ total: 4, red: 2, yellow: 1, green: 0, unclassified: 1 });
  });

  it('ignores the scope argument (scheduler is global, not an end-user)', async () => {
    await provider.get({ date: '2026-08-23', scope: ['骨科'] });

    const callWhere = prisma.monitorRecord.groupBy.mock.calls[0][0].where;
    expect(callWhere).not.toHaveProperty('department');
    expect(callWhere).toEqual({
      examTime: expect.any(Object),
    });
  });

  it('counts the full inventory when date is absent', async () => {
    await provider.get({});

    expect(prisma.monitorRecord.groupBy).toHaveBeenCalledWith({
      by: ['currentLevel'],
      where: {},
      _count: { _all: true },
    });
  });

  it('maps every level key including GREEN to zero when no group matches', async () => {
    prisma.monitorRecord.groupBy.mockResolvedValueOnce([]);

    const summary = await provider.get({ date: '2026-08-23' });

    expect(summary).toEqual({ total: 0, red: 0, yellow: 0, green: 0, unclassified: 0 });
  });
});
