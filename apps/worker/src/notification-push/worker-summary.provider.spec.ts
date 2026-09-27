import { WorkerSummaryProvider } from './worker-summary.provider';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Unit tests for the worker's summary provider (issue: push rules). It must
 * reproduce the api's "今日新报告" buckets with its own GROUP BY (a scheduled
 * push cannot depend on the api being up); the day-window boundary math is
 * shared via resolveShanghaiDayRange, so here we only assert the Prisma where
 * shape and the level-key mapping. Issue #69 adds the keyword-hit aggregation
 * (monitor_match grouped by keyword+level in the same window, enabled rules
 * only); issue #87 adds `semanticFiltered: false` to it, so a push counts the
 * same effective hits the 监控看板 shows.
 */
describe('WorkerSummaryProvider', () => {
  let prisma: {
    monitorRecord: { groupBy: jest.Mock };
    monitorMatch: { groupBy: jest.Mock };
  };
  let provider: WorkerSummaryProvider;

  const DAY_RANGE = {
    gte: new Date('2026-08-22T16:00:00.000Z'),
    lt: new Date('2026-08-23T16:00:00.000Z'),
  };

  beforeEach(() => {
    prisma = {
      monitorRecord: {
        groupBy: jest.fn(async () => [
          { currentLevel: 'RED', _count: { _all: 2 } },
          { currentLevel: 'YELLOW', _count: { _all: 1 } },
          { currentLevel: 'UNCLASSIFIED', _count: { _all: 1 } },
        ]),
      },
      monitorMatch: {
        groupBy: jest.fn(async () => [
          { keyword: '恶性肿瘤', level: 'RED', _count: { _all: 2 } },
          { keyword: '肿物', level: 'YELLOW', _count: { _all: 1 } },
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
        examTime: DAY_RANGE,
      },
      _count: { _all: true },
    });
    expect(prisma.monitorMatch.groupBy).toHaveBeenCalledWith({
      by: ['keyword', 'level'],
      where: {
        record: { examTime: DAY_RANGE },
        rule: { isEnabled: true },
        // Issue #87: hits the AI semantic judge removed are not hits.
        semanticFiltered: false,
      },
      _count: { _all: true },
    });
    expect(summary).toEqual({
      total: 4,
      red: 2,
      yellow: 1,
      green: 0,
      unclassified: 1,
      keywordHits: [
        { keyword: '恶性肿瘤', level: 'RED', count: 2 },
        { keyword: '肿物', level: 'YELLOW', count: 1 },
      ],
    });
  });

  it('ignores the scope argument (scheduler is global, not an end-user)', async () => {
    await provider.get({ date: '2026-08-23', scope: ['骨科'] });

    const recordWhere = prisma.monitorRecord.groupBy.mock.calls[0][0].where;
    expect(recordWhere).not.toHaveProperty('department');
    expect(recordWhere).toEqual({ examTime: DAY_RANGE });

    const matchWhere = prisma.monitorMatch.groupBy.mock.calls[0][0].where;
    expect(matchWhere).toEqual({
      record: { examTime: DAY_RANGE },
      rule: { isEnabled: true },
      semanticFiltered: false,
    });
  });

  it('counts the full inventory when date is absent', async () => {
    await provider.get({});

    expect(prisma.monitorRecord.groupBy).toHaveBeenCalledWith({
      by: ['currentLevel'],
      where: {},
      _count: { _all: true },
    });
    expect(prisma.monitorMatch.groupBy).toHaveBeenCalledWith({
      by: ['keyword', 'level'],
      where: { rule: { isEnabled: true }, semanticFiltered: false },
      _count: { _all: true },
    });
  });

  it('maps every level key including GREEN to zero when no group matches', async () => {
    prisma.monitorRecord.groupBy.mockResolvedValueOnce([]);
    prisma.monitorMatch.groupBy.mockResolvedValueOnce([]);

    const summary = await provider.get({ date: '2026-08-23' });

    expect(summary).toEqual({
      total: 0,
      red: 0,
      yellow: 0,
      green: 0,
      unclassified: 0,
      keywordHits: [],
    });
  });
});
