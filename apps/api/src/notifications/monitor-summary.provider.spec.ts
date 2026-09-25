import { MonitorSummaryProvider } from './notification-push.adapters';
import { PrismaService } from '../prisma/prisma.service';
import { MonitorService } from '../monitor/monitor.service';

/**
 * The api's push summary provider: it must report EXACTLY what the 监控看板
 * shows for the same scope, because a WeCom card that disagrees with the
 * workbench is worse than no card. The counts come straight from
 * MonitorService.summary (already covered); what this spec pins down is the
 * keyword-hit aggregation, which this class computes itself - issue #69's
 * enabled-rules-only rule plus issue #87's effective-hits-only rule.
 */
describe('MonitorSummaryProvider', () => {
  function makeFakePrisma(keywordGroups: unknown[] = []) {
    return {
      monitorMatch: { groupBy: jest.fn().mockResolvedValue(keywordGroups) },
    };
  }

  function makeFakeMonitor(summary: Record<string, number> = {}) {
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

  function build(prisma: unknown, monitor: MonitorService) {
    return new MonitorSummaryProvider(monitor, prisma as PrismaService);
  }

  it('counts effective hits inside the same day window, honoring the scope', async () => {
    const prisma = makeFakePrisma([{ keyword: '恶性肿瘤', level: 'RED', _count: { _all: 3 } }]);
    const monitor = makeFakeMonitor({ red: 2, total: 2 });
    const provider = build(prisma, monitor);

    const summary = await provider.get({ date: '2026-09-03', scope: ['消化内科'] });

    // Same window + scope as the level counts, so the two halves of one card
    // describe the same population.
    expect(monitor.summary).toHaveBeenCalledWith(
      { examDateFrom: '2026-09-03', examDateTo: '2026-09-03' },
      { scope: ['消化内科'] },
    );
    expect(prisma.monitorMatch.groupBy).toHaveBeenCalledWith({
      by: ['keyword', 'level'],
      where: {
        record: {
          examTime: {
            gte: new Date('2026-09-02T16:00:00.000Z'),
            lt: new Date('2026-09-03T16:00:00.000Z'),
          },
          department: { in: ['消化内科'] },
        },
        rule: { isEnabled: true },
        // Issue #87: a filtered hit is not one of the day's keyword hits.
        semanticFiltered: false,
      },
      _count: { _all: true },
    });
    expect(summary).toEqual({
      total: 2,
      red: 2,
      yellow: 0,
      green: 0,
      unclassified: 0,
      keywordHits: [{ keyword: '恶性肿瘤', level: 'RED', count: 3 }],
    });
  });

  it('omits the day window and the scope when neither is given (full inventory)', async () => {
    const prisma = makeFakePrisma();
    const provider = build(prisma, makeFakeMonitor());

    await provider.get({});

    expect(prisma.monitorMatch.groupBy).toHaveBeenCalledWith({
      by: ['keyword', 'level'],
      // `record` stays as an empty object rather than being dropped - the
      // relation filter is always present, with only its contents conditional.
      where: { record: {}, rule: { isEnabled: true }, semanticFiltered: false },
      _count: { _all: true },
    });
  });

  it('omits only the department condition for an empty scope', async () => {
    const prisma = makeFakePrisma();
    const provider = build(prisma, makeFakeMonitor());

    await provider.get({ date: '2026-09-03', scope: [] });

    const where = (
      prisma.monitorMatch.groupBy.mock.calls[0][0] as { where: Record<string, unknown> }
    ).where;
    expect(where.record).not.toHaveProperty('department');
  });
});
